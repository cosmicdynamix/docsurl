-- Optional sender signature: a saved default per user, and a copy kept on each link
ALTER TABLE users ADD COLUMN signature jsonb;
ALTER TABLE links ADD COLUMN signature jsonb;
