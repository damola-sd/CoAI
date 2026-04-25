from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="COAI_", env_file=".env", extra="ignore")

    environment: str = "local"
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/codebase_onboarding"
    embeddings_provider: str = "fake"
    embeddings_dim: int = 1536
    repo_storage_path: str = ".data/repos"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4.1-mini"


settings = Settings()
