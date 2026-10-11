"""Same-origin quiz API. Production requires PostgreSQL and explicit secrets."""
import base64
import csv
import hashlib
import hmac
import io
import json
import os
import secrets
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import (Boolean, CheckConstraint, Column, Float, Integer, JSON, String, Text,
                        UniqueConstraint, create_engine, select, text)
from sqlalchemy.orm import DeclarativeBase, Session

from engine.generator import generate, canonical_json, load_library

ROOT = Path(__file__).resolve().parents[1]
LIB = load_library()
QUESTIONS = json.loads((ROOT / 'content/questions-v1.json').read_text('utf-8'))
PRODUCTION = os.getenv('APP_ENV') == 'production'
DATABASE_URL = os.getenv('DATABASE_URL', 'sqlite:///./development.db')
SECRET = os.getenv('APP_SECRET', '')
ADMIN_KEY = os.getenv('ADMIN_KEY', '')
PUBLIC_ORIGIN = os.getenv('PUBLIC_ORIGIN', 'http://127.0.0.1:5173').rstrip('/')
if PRODUCTION and (not DATABASE_URL.startswith('postgresql') or len(SECRET) < 40 or len(ADMIN_KEY) < 32 or 'REPLACE' in SECRET or 'REPLACE' in ADMIN_KEY):
    raise RuntimeError('Production requires PostgreSQL, APP_SECRET >= 40 chars, ADMIN_KEY >= 32 chars')
if not SECRET:
    # Local-only secret is persisted so reopening the development server keeps codes valid.
    secret_path = ROOT / 'local-secrets.json'
    if not secret_path.exists():
        secret_path.write_text(json.dumps({'secret': secrets.token_urlsafe(48), 'admin': secrets.token_urlsafe(32)}), 'utf-8')
    local = json.loads(secret_path.read_text('utf-8'))
    SECRET, ADMIN_KEY = local['secret'], local['admin']
KEY = hashlib.sha256(('encryption:' + SECRET).encode()).digest()
engine = create_engine(DATABASE_URL, pool_pre_ping=True, **({'connect_args': {'check_same_thread': False, 'timeout': 30}} if DATABASE_URL.startswith('sqlite') else {}))


class Base(DeclarativeBase):
    pass


class Visitor(Base):
    __tablename__ = 'quiz_visitors'
    id = Column(String(64), primary_key=True)
    csrf = Column(String(64), nullable=False)
    expires = Column(Float, nullable=False)
    admin_until = Column(Float, default=0, nullable=False)


class Code(Base):
    __tablename__ = 'quiz_codes'
    __table_args__ = (CheckConstraint('used >= 0 AND used <= 3', name='quiz_code_quota_bounds'),)
    id = Column(String(36), primary_key=True)
    digest = Column(String(64), unique=True, nullable=False)
    product = Column(String(8), nullable=False)
    used = Column(Integer, default=0, nullable=False)
    active = Column(Boolean, default=True, nullable=False)


class Grant(Base):
    __tablename__ = 'quiz_grants'
    __table_args__ = (UniqueConstraint('visitor', 'code'),)
    id = Column(String(36), primary_key=True)
    visitor = Column(String(64), nullable=False)
    code = Column(String(36), nullable=False)


class Attempt(Base):
    __tablename__ = 'quiz_attempts'
    id = Column(String(36), primary_key=True)
    visitor = Column(String(64), nullable=False)
    code = Column(String(36), nullable=False, index=True)
    product = Column(String(8), nullable=False)
    created = Column(Float, nullable=False)
    expires = Column(Float, nullable=False)
    answers = Column(JSON, default=dict, nullable=False)
    revision = Column(Integer, default=0, nullable=False)
    result = Column(String(36), nullable=True)
    answer_key = Column(String(64), nullable=True)


class Result(Base):
    __tablename__ = 'quiz_results'
    id = Column(String(36), primary_key=True)
    attempt = Column(String(36), unique=True, nullable=False)
    visitor = Column(String(64), nullable=False)
    report = Column(JSON, nullable=False)
    share_digest = Column(String(64), unique=True, nullable=False)
    share_encrypted = Column(Text, nullable=False)
    share_active = Column(Boolean, default=True, nullable=False)


class Usage(Base):
    __tablename__ = 'quiz_usage'
    attempt = Column(String(36), primary_key=True)
    code = Column(String(36), nullable=False)
    result = Column(String(36), unique=True, nullable=False)
    created = Column(Float, nullable=False)


class Batch(Base):
    __tablename__ = 'quiz_batches'
    id = Column(String(36), primary_key=True)
    request_key = Column(String(80), unique=True, nullable=False)
    product = Column(String(8), nullable=False)
    count = Column(Integer, nullable=False)
    encrypted = Column(Text, nullable=False)
    expires = Column(Float, nullable=False)


class Rate(Base):
    __tablename__ = 'quiz_rates'
    id = Column(String(64), primary_key=True)
    count = Column(Integer, default=0, nullable=False)
    reset = Column(Float, nullable=False)


@contextmanager
def transaction():
    with Session(engine, expire_on_commit=False) as db:
        try:
            if engine.dialect.name == 'sqlite':
                db.execute(text('BEGIN IMMEDIATE'))
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise


def uid():
    return str(uuid.uuid4())


def digest(value):
    return hmac.new(SECRET.encode(), value.encode(), hashlib.sha256).hexdigest()


def encrypt(value):
    nonce = secrets.token_bytes(12)
    return base64.urlsafe_b64encode(nonce + AESGCM(KEY).encrypt(nonce, value.encode(), b'quiz-v1')).decode()


def decrypt(value):
    raw = base64.urlsafe_b64decode(value)
    return AESGCM(KEY).decrypt(raw[:12], raw[12:], b'quiz-v1').decode()


def fail(status, message):
    raise HTTPException(status, message)


def visitor(db, request, admin=False):
    token = request.cookies.get('quiz_session', '')
    row = db.get(Visitor, digest('session:' + token)) if token else None
    if not row or row.expires <= time.time():
        fail(401, '会话已过期，请重新输入测评码')
    if admin and row.admin_until <= time.time():
        fail(403, '请先登录管理端')
    if request.method not in ('GET', 'HEAD') and not hmac.compare_digest(request.headers.get('x-csrf-token', ''), row.csrf):
        fail(403, '页面验证失效，请刷新后重试')
    return row


def rate(db, namespace, identity, limit, seconds):
    # PostgreSQL advisory lock serializes creation too (no absent-row race).
    key = digest(namespace + ':' + identity)
    if engine.dialect.name == 'postgresql':
        db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': int(key[:15], 16)})
    row = db.get(Rate, key)
    now = time.time()
    if not row:
        db.add(Rate(id=key, count=1, reset=now + seconds))
        return True
    if row.reset <= now:
        row.count, row.reset = 0, now + seconds
    row.count += 1
    return row.count <= limit


def locked_code(db, code_id):
    row = db.scalar(select(Code).where(Code.id == code_id).with_for_update())
    if not row or not row.active:
        fail(403, '这个测评码已停用')
    return row


def owned_attempt(db, request, attempt_id):
    user = visitor(db, request)
    initial = db.get(Attempt, attempt_id)
    if not initial or initial.visitor != user.id:
        fail(404, '未找到你的测评')
    code = locked_code(db, initial.code)
    attempt = db.scalar(select(Attempt).where(Attempt.id == attempt_id).with_for_update().execution_options(populate_existing=True))
    return user, code, attempt


def attempt_view(a, c):
    return {'id': a.id, 'product': a.product, 'answers': a.answers, 'revision': a.revision, 'result_id': a.result, 'remaining': 3 - c.used, 'expires': a.expires}


def public_report(report):
    return {key: report[key] for key in ('result_version', 'question_version', 'product', 'product_name', 'mode', 'headline', 'band', 'cards', 'notice')}


app = FastAPI(title='灵魂小馆', docs_url=None if PRODUCTION else '/docs', redoc_url=None)


@app.middleware('http')
async def security_headers(request, call_next):
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        if request.headers.get('origin') != PUBLIC_ORIGIN:
            return JSONResponse({'detail': '请求来源不匹配'}, status_code=403)
    response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'"
    if request.url.path.startswith('/api'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/api/health')
def health():
    with engine.connect() as conn:
        conn.execute(text('SELECT 1'))
    return {'ok': True, 'result_version': LIB['version']}


@app.get('/api/session')
def get_session(request: Request, response: Response):
    with transaction() as db:
        token = request.cookies.get('quiz_session', '')
        row = db.get(Visitor, digest('session:' + token)) if token else None
        if not row or row.expires <= time.time():
            token = secrets.token_urlsafe(32)
            row = Visitor(id=digest('session:' + token), csrf=secrets.token_urlsafe(32), expires=time.time()+86400*30, admin_until=0)
            db.add(row)
            response.set_cookie('quiz_session', token, httponly=True, secure=PRODUCTION, samesite='lax', max_age=86400*30, path='/')
        return {'csrf': row.csrf, 'admin': row.admin_until > time.time()}


@app.get('/api/catalog')
def catalog():
    return {'version': QUESTIONS['version'], 'products': [{'id': key, 'name': value['name'], 'questions': QUESTIONS['products'][key]} for key, value in LIB['products'].items()]}


class VerifyBody(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    product: str = Field(max_length=8)


@app.post('/api/codes/verify')
def verify(body: VerifyBody, request: Request):
    if body.product not in LIB['products']:
        fail(422, '未知测评')
    denied = None
    with transaction() as db:
        user = visitor(db, request)
        ip = request.client.host if request.client else 'unknown'
        if not rate(db, 'verify-ip', ip, 30, 600) or not rate(db, 'verify-user', user.id, 15, 600):
            denied = (429, '尝试次数较多，请十分钟后再试')
        else:
            clean = body.code.replace('-', '').replace(' ', '').upper()
            row = db.scalar(select(Code).where(Code.digest == digest('code:' + clean)).with_for_update())
            if not row or not row.active:
                denied = (400, '测评码不正确或已停用')
            elif row.used >= 3:
                denied = (409, '这个测评码的三次机会已经用完')
            else:
                grant = db.scalar(select(Grant).where(Grant.visitor == user.id, Grant.code == row.id))
                if not grant:
                    grant = Grant(id=uid(), visitor=user.id, code=row.id)
                    db.add(grant)
                result = {'grant_id': grant.id, 'remaining': 3 - row.used, 'product': body.product}
    if denied:
        fail(*denied)
    return result


class StartBody(BaseModel):
    grant_id: str = Field(max_length=36)
    product: str = Field(max_length=8)


@app.post('/api/attempts')
def start(body: StartBody, request: Request):
    if body.product not in LIB['products']:
        fail(422, '未知测评')
    with transaction() as db:
        user = visitor(db, request)
        grant = db.get(Grant, body.grant_id)
        if not grant or grant.visitor != user.id:
            fail(404, '请先验证测评码')
        code = locked_code(db, grant.code)
        now = time.time()
        attempts = list(db.scalars(select(Attempt).where(Attempt.code == code.id, Attempt.result.is_(None), Attempt.expires > now)))
        for attempt in attempts:
            if attempt.visitor == user.id and attempt.product == body.product:
                return attempt_view(attempt, code)
        if code.used + len(attempts) >= 3:
            fail(409, '机会已用完或有其他设备正在测评，请稍后重试')
        a = Attempt(id=uid(), visitor=user.id, code=code.id, product=body.product, created=now, expires=now+3600, answers={}, revision=0)
        db.add(a)
        return attempt_view(a, code)


@app.get('/api/attempts/{attempt_id}')
def get_attempt(attempt_id: str, request: Request):
    with transaction() as db:
        _, code, a = owned_attempt(db, request, attempt_id)
        return attempt_view(a, code)


class DraftBody(BaseModel):
    answers: dict[str, str] = Field(max_length=24)
    revision: int = Field(ge=0)


@app.patch('/api/attempts/{attempt_id}')
def draft(attempt_id: str, body: DraftBody, request: Request):
    if any(k not in {f'Q{i:02d}' for i in range(1, 25)} or v not in ('A','B','C','D') for k,v in body.answers.items()):
        fail(422, '答案格式不正确')
    with transaction() as db:
        _, code, a = owned_attempt(db, request, attempt_id)
        if a.result:
            fail(409, '这次测评已完成，结果不能改写')
        if a.expires <= time.time():
            fail(410, '这次测评已过期，请重新开始')
        if a.revision != body.revision:
            fail(409, '另一页面已更新答案，请刷新以载入最新进度')
        a.answers, a.revision = body.answers, a.revision + 1
        a.expires = min(time.time()+3600, a.created+86400)
        return attempt_view(a, code)


class CompleteBody(BaseModel):
    answers: dict[str, str] = Field(min_length=24, max_length=24)


@app.post('/api/attempts/{attempt_id}/complete')
def complete(attempt_id: str, body: CompleteBody, request: Request):
    with transaction() as db:
        user, code, a = owned_attempt(db, request, attempt_id)
        try:
            report = generate(a.product, body.answers)
        except ValueError as exc:
            fail(422, str(exc))
        if a.result:
            if a.answer_key != report['answer_key']:
                fail(409, '本次测评已提交，请开始新一轮测评')
            return {'result_id': a.result, 'remaining': 3-code.used}
        if a.expires <= time.time():
            fail(410, '测评已过期，请重新开始；本次未扣次数')
        if code.used >= 3:
            fail(409, '机会已经用完')
        result_id, share = uid(), secrets.token_urlsafe(32)
        db.add(Result(id=result_id, attempt=a.id, visitor=user.id, report=report, share_digest=digest('share:'+share), share_encrypted=encrypt(share), share_active=True))
        db.add(Usage(attempt=a.id, code=code.id, result=result_id, created=time.time()))
        a.result, a.answer_key, a.answers = result_id, report['answer_key'], body.answers
        code.used += 1
        return {'result_id': result_id, 'remaining': 3-code.used}


@app.get('/api/results/{result_id}')
def result(result_id: str, request: Request):
    with transaction() as db:
        user = visitor(db, request)
        row = db.get(Result, result_id)
        if not row or row.visitor != user.id:
            fail(404, '未找到你的结果')
        report = dict(row.report)
        return {'report': report, 'share_url': PUBLIC_ORIGIN+'/s/'+decrypt(row.share_encrypted) if row.share_active else None}


@app.get('/api/share/{token}')
def share(token: str):
    if len(token) > 64:
        fail(404, '分享链接无效')
    with transaction() as db:
        row = db.scalar(select(Result).where(Result.share_digest == digest('share:'+token), Result.share_active.is_(True)))
        if not row:
            fail(404, '分享链接无效或已取消')
        return {'report': public_report(row.report), 'share_url': PUBLIC_ORIGIN+'/s/'+token}


@app.delete('/api/results/{result_id}/share')
def revoke(result_id: str, request: Request):
    with transaction() as db:
        user = visitor(db, request)
        row = db.get(Result, result_id)
        if not row or row.visitor != user.id:
            fail(404, '未找到你的结果')
        row.share_active = False
        return {'ok': True}


class AdminLogin(BaseModel):
    key: str = Field(max_length=200)


@app.post('/api/admin/login')
def admin_login(body: AdminLogin, request: Request):
    rejected = None
    with transaction() as db:
        user = visitor(db, request)
        if not rate(db, 'admin-login', request.client.host if request.client else '', 5, 900):
            rejected = (429, '请十五分钟后再试')
        elif not ADMIN_KEY or not hmac.compare_digest(body.key, ADMIN_KEY):
            rejected = (403, '管理密钥不正确')
        else:
            user.admin_until = time.time()+3600
    if rejected:
        fail(*rejected)
    return {'ok': True}


@app.post('/api/admin/logout')
def admin_logout(request: Request):
    with transaction() as db:
        visitor(db, request).admin_until = 0
    return {'ok': True}


class BatchBody(BaseModel):
    count: int = Field(default=100, ge=1, le=100)
    request_key: str = Field(min_length=16, max_length=80)


@app.post('/api/admin/batches')
def create_batch(body: BatchBody, request: Request):
    with transaction() as db:
        visitor(db, request, True)
        if engine.dialect.name == 'postgresql':
            db.execute(text('SELECT pg_advisory_xact_lock(:key)'), {'key': int(digest('batch:'+body.request_key)[:15],16)})
        old = db.scalar(select(Batch).where(Batch.request_key == body.request_key))
        if old:
            if old.count != body.count:
                fail(409, '请求编号已用于其他批次')
            return {'id': old.id, 'count': old.count, 'expires': old.expires}
        codes = []
        alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
        for _ in range(body.count):
            raw = ''.join(secrets.choice(alphabet) for _ in range(16))
            codes.append('-'.join(raw[i:i+4] for i in range(0,16,4)))
            db.add(Code(id=uid(), digest=digest('code:'+raw), product='all', used=0, active=True))
        batch = Batch(id=uid(), request_key=body.request_key, product='all', count=body.count, encrypted=encrypt(json.dumps(codes)), expires=time.time()+86400)
        db.add(batch)
        return {'id': batch.id, 'count': batch.count, 'expires': batch.expires}


@app.get('/api/admin/batches/{batch_id}/export')
def export(batch_id: str, request: Request):
    with transaction() as db:
        visitor(db, request, True)
        row = db.get(Batch, batch_id)
        if not row or row.expires <= time.time():
            fail(410, '批次明文导出已过期，请妥善保管已下载文件')
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(['测评码','测评','可用次数'])
        for code in json.loads(decrypt(row.encrypted)):
            writer.writerow([code, '四款通用（合计3次）', 3])
        return Response(content=('\ufeff'+stream.getvalue()).encode('utf-8'), media_type='text/csv', headers={'Content-Disposition': f'attachment; filename="quiz-codes-all-{row.id}.csv"'})


DIST = ROOT / 'web/dist'
if DIST.exists():
    app.mount('/assets', StaticFiles(directory=DIST/'assets'), name='assets')
    @app.get('/{path:path}')
    def spa(path: str):
        if path.startswith('api/'):
            fail(404, '接口不存在')
        return FileResponse(DIST/'index.html')


if __name__ == '__main__':
    raise SystemExit('Run python -m api.migrate, then uvicorn api.main:app')
