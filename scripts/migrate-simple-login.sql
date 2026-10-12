BEGIN;
ALTER TABLE usuario_web DROP CONSTRAINT IF EXISTS usuario_web_username_check;
ALTER TABLE usuario_web ADD CONSTRAINT usuario_web_username_check
  CHECK (char_length(username) BETWEEN 1 AND 80 AND username=btrim(username) AND username !~ '[[:cntrl:]]');
ALTER TABLE usuario_web ALTER COLUMN must_change_password SET DEFAULT false;
DELETE FROM usuario_web_recovery;
UPDATE usuario_web SET must_change_password=false,mfa_secret=NULL,mfa_enabled=false,last_totp_step=0,
  session_version=session_version+1,updated_at=now();
TRUNCATE TABLE session;
COMMIT;
