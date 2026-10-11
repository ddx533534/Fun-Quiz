"""Run with the database owner during deployment; runtime account needs only DML."""
from sqlalchemy import text
from api.main import Base, engine

Base.metadata.create_all(engine)
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
