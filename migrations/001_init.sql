-- M0: users, sessions, audit log

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text NOT NULL UNIQUE,
  display_name         text NOT NULL,
  role                 text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  totp_secret_enc      text,
  totp_enabled         boolean NOT NULL DEFAULT false,
  totp_required        boolean NOT NULL DEFAULT false,
  theme                text NOT NULL DEFAULT 'system' CHECK (theme IN ('dark', 'light', 'system')),
  is_active            boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz
);

CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  ip_hash     text,
  ua          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb,
  ip_hash     text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_at_idx ON audit_log(at DESC);
