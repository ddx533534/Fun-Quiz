$ErrorActionPreference = 'Stop'
$quizRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $quizRoot
$quizPython = Join-Path $quizRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $quizPython)) { throw '请先创建 .venv 并安装 api/requirements.txt' }
& $quizPython -m api.migrate
if ($LASTEXITCODE -ne 0) { throw '数据库初始化失败' }
& $quizPython -m uvicorn api.main:app --host 127.0.0.1 --port 8000 --no-access-log
