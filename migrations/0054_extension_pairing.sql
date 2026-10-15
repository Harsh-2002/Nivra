CREATE TABLE extension_pairing (
  code_hash TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX extension_pairing_expires_idx ON extension_pairing(expires_at);

CREATE TABLE extension_keys (
  key_id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  extension_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX extension_keys_owner_idx ON extension_keys(owner_id);

CREATE TRIGGER apikey_extension_cleanup AFTER DELETE ON apikey BEGIN
  DELETE FROM extension_keys WHERE key_id=old.id;
END;
