FROM node:24-bookworm-slim AS frontend
WORKDIR /build
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app
COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r api/requirements.txt
COPY api/ /app/api/
COPY engine/ /app/engine/
COPY content/ /app/content/
COPY --from=frontend /build/dist /app/web/dist
RUN useradd --create-home quiz
USER quiz
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-proxy-headers", "--no-access-log"]
