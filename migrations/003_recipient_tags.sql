-- Who a link was made for, plus free-form tags
ALTER TABLE links
  ADD COLUMN recipient text,
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX links_tags_idx ON links USING gin (tags);
