CREATE TABLE IF NOT EXISTS ai_hub_user_settings (
  user_id TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_hub_threads (
  user_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, model_id)
);
