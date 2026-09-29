from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Backend settings. Single-user local deployment: no auth."""

    # CORS — main.py whitelists this SPA origin next to the Vite dev ports.
    FRONTEND_URL: str = "http://localhost:5173"

    # Project store, e.g. postgresql+asyncpg://velxio:velxio@postgres:5432/velxio.
    # Unset: /api/projects answers 503 and the editor keeps work in the browser.
    DATABASE_URL: str | None = None

    # extra="ignore": tolerate unrelated keys in a shared .env file instead of
    # crashing at startup with extra_forbidden.
    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
