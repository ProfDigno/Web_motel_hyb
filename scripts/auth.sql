CREATE TABLE IF NOT EXISTS sync_run (
  id bigserial PRIMARY KEY,
  finished_at timestamptz NOT NULL DEFAULT now(),
  source_count integer NOT NULL,
  report_count integer NOT NULL
);
CREATE TABLE IF NOT EXISTS usuario_web (
  user_id serial PRIMARY KEY,
  username text NOT NULL CHECK (char_length(username) BETWEEN 1 AND 80 AND username=btrim(username) AND username !~ '[[:cntrl:]]'),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','consulta')),
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT false,
  session_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS usuario_web_username_ci ON usuario_web (lower(username));
CREATE TABLE IF NOT EXISTS auth_rate_limit (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  window_start timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS session (
  sid varchar NOT NULL PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS session_expire_idx ON session (expire);
CREATE TABLE IF NOT EXISTS web_audit (
  id bigserial PRIMARY KEY,
  actor_user_id integer REFERENCES usuario_web(user_id),
  target_user_id integer REFERENCES usuario_web(user_id),
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS occupancy_snapshot (
  room_id integer PRIMARY KEY,
  reception_id integer NOT NULL DEFAULT 0,
  room_number integer NOT NULL UNIQUE,
  room_type text NOT NULL,
  state text NOT NULL,
  state_description text NOT NULL,
  room_description text NOT NULL,
  elapsed_label text NOT NULL,
  elapsed_seconds integer NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
  amount numeric NOT NULL DEFAULT 0,
  background_color text NOT NULL DEFAULT '#F0F0F0',
  text_color text NOT NULL DEFAULT '#000000',
  entry_at timestamp without time zone,
  is_hour boolean NOT NULL DEFAULT false,
  is_sleep boolean NOT NULL DEFAULT false,
  is_lodging boolean NOT NULL DEFAULT false,
  advance numeric NOT NULL DEFAULT 0,
  extra_hours integer NOT NULL DEFAULT 0,
  client_door boolean NOT NULL DEFAULT false,
  cleaning_door boolean NOT NULL DEFAULT false,
  is_manual boolean NOT NULL DEFAULT false,
  minimum_amount numeric NOT NULL DEFAULT 0,
  additional_unit_amount numeric NOT NULL DEFAULT 0,
  consumption_amount numeric NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  source_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS occupancy_snapshot_order_idx ON occupancy_snapshot(sort_order,room_number);
