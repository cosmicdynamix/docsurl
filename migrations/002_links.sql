-- M1: links (files and short URLs), file versions, page images, basic view log

CREATE TABLE links (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug               text NOT NULL UNIQUE,
  kind               text NOT NULL CHECK (kind IN ('file', 'url')),
  title              text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  destination_url    text,
  password_hash      text,
  expires_at         timestamptz,
  max_views          integer CHECK (max_views IS NULL OR max_views > 0),
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'url' AND destination_url IS NOT NULL) OR (kind = 'file'))
);
CREATE INDEX links_owner_idx ON links(owner_id);

CREATE TABLE link_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id       uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  version_no    integer NOT NULL,
  original_name text,
  page_count    integer NOT NULL,
  file_sha256   text NOT NULL,
  size_bytes    bigint NOT NULL,
  note          text,
  uploaded_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (link_id, version_no)
);

ALTER TABLE links
  ADD CONSTRAINT links_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES link_versions(id) ON DELETE SET NULL;

CREATE TABLE link_pages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES link_versions(id) ON DELETE CASCADE,
  page_no    integer NOT NULL,
  width      integer NOT NULL,
  height     integer NOT NULL,
  UNIQUE (version_id, page_no)
);

-- Basic view log (M1). M2 adds sessions/heartbeats/page events and UA parsing.
CREATE TABLE views (
  id               bigserial PRIMARY KEY,
  link_id          uuid NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  version_id       uuid REFERENCES link_versions(id) ON DELETE SET NULL,
  started_at       timestamptz NOT NULL DEFAULT now(),
  ip_hash          text,
  country          text,
  region           text,
  city             text,
  latitude         double precision,
  longitude        double precision,
  timezone         text,
  user_agent       text,
  referrer_url     text,
  referrer_host    text,
  src_tag          text,
  is_bot           boolean NOT NULL DEFAULT false,
  is_owner_preview boolean NOT NULL DEFAULT false
);
CREATE INDEX views_link_time_idx ON views(link_id, started_at DESC);
