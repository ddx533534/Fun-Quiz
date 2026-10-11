import os
import pytest

os.environ['APP_ENV']='test'
os.environ['APP_SECRET']='test-secret-not-for-production-'+'a'*40
os.environ['ADMIN_KEY']='test-admin-key-'+'b'*40
os.environ['PUBLIC_ORIGIN']='http://testserver'
os.environ['DATABASE_URL']=os.getenv('TEST_DATABASE_URL','sqlite:///./test-api.db')

from api.main import Base, engine


@pytest.fixture(autouse=True)
def clean_database():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield
