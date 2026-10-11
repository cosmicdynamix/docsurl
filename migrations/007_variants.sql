-- Desktop / mobile variants: a version can hold two PDFs (desktop and an optional mobile one).
-- "desktop" is also the default file used by every device when no mobile file exists.
CREATE TABLE version_files (
  version_id    uuid    NOT NULL REFERENCES link_versions(id) ON DELETE CASCADE,
  variant       text    NOT NULL CHECK (variant IN ('desktop', 'mobile')),
  original_name text,
  page_count    integer NOT NULL,
  file_sha256   text    NOT NULL,
  size_bytes    bigint  NOT NULL,
  PRIMARY KEY (version_id, variant)
);

INSERT INTO version_files (version_id, variant, original_name, page_count, file_sha256, size_bytes)
SELECT id, 'desktop', original_name, page_count, file_sha256, size_bytes FROM link_versions;

ALTER TABLE link_pages ADD COLUMN variant text NOT NULL DEFAULT 'desktop' CHECK (variant IN ('desktop', 'mobile'));
ALTER TABLE link_pages DROP CONSTRAINT link_pages_version_id_page_no_key;
ALTER TABLE link_pages ADD CONSTRAINT link_pages_version_variant_page_key UNIQUE (version_id, variant, page_no);

-- Which variant a visit was served (page numbers in view_pages / max_page refer to it)
ALTER TABLE views ADD COLUMN variant text NOT NULL DEFAULT 'desktop' CHECK (variant IN ('desktop', 'mobile'));
