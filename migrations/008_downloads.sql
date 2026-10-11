-- Optional per-link download permission, and a counter of downloads per visit
ALTER TABLE links ADD COLUMN allow_download boolean NOT NULL DEFAULT false;
ALTER TABLE views ADD COLUMN downloads integer NOT NULL DEFAULT 0;
