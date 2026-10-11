-- "Confidential - For <recipient>" stamp burned into every page image
ALTER TABLE links ADD COLUMN stamp boolean NOT NULL DEFAULT true;
