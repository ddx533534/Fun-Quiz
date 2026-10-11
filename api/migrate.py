"""Run with the database owner during deployment; runtime account needs only DML."""
from sqlalchemy import inspect, text
from api.main import Base, engine

Base.metadata.create_all(engine)
with engine.begin() as conn:
    columns = {c['name'] for c in inspect(conn).get_columns('quiz_attempts')}
    if 'product' not in columns:
        # Backfill BEFORE converting legacy code labels; keep historical attempts/results.
        conn.execute(text("ALTER TABLE quiz_attempts ADD COLUMN product VARCHAR(8) NOT NULL DEFAULT 'past'"))
        conn.execute(text("UPDATE quiz_attempts SET product = (SELECT product FROM quiz_codes WHERE quiz_codes.id = quiz_attempts.code)"))
    conn.execute(text("UPDATE quiz_codes SET product = 'all' WHERE product <> 'all'"))
    conn.execute(text("UPDATE quiz_batches SET product = 'all' WHERE product <> 'all'"))
if engine.dialect.name == 'postgresql':
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            # No browser-facing roles may query these private tables.
            conn.execute(text(f'ALTER TABLE {table.name} ENABLE ROW LEVEL SECURITY'))
            for role in ('anon', 'authenticated'):
                exists = conn.execute(text('SELECT 1 FROM pg_roles WHERE rolname=:role'), {'role':role}).scalar()
                if exists:
                    conn.execute(text(f'REVOKE ALL ON TABLE {table.name} FROM {role}'))
print('Schema ready:', engine.dialect.name)
