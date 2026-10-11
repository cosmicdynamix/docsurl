-- M2: per-visit engagement + parsed user agent

ALTER TABLE views
  ADD COLUMN visitor_id        text,
  ADD COLUMN ended_at          timestamptz,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN open_ms           integer,   -- wall-clock time the page stayed open
  ADD COLUMN active_ms         integer,   -- time the tab was visible AND the visitor was interacting
  ADD COLUMN max_page          integer,   -- deepest page reached
  ADD COLUMN top_dwell_page    integer,   -- page with the most active time
  ADD COLUMN browser           text,
  ADD COLUMN browser_ver       text,
  ADD COLUMN os                text,
  ADD COLUMN os_ver            text,
  ADD COLUMN device_type       text,
  ADD COLUMN in_app            text,      -- in-app browser hint (Instagram, LinkedIn, ...)
  ADD COLUMN lang              text,
  ADD COLUMN screen_w          integer,
  ADD COLUMN screen_h          integer;

-- Cumulative active time per page per visit (client sends running totals, so updates are idempotent)
CREATE TABLE view_pages (
  view_id  bigint  NOT NULL REFERENCES views(id) ON DELETE CASCADE,
  page_no  integer NOT NULL,
  dwell_ms integer NOT NULL DEFAULT 0,
  PRIMARY KEY (view_id, page_no)
);

CREATE INDEX views_visitor_idx ON views(link_id, visitor_id);
CREATE INDEX views_version_idx ON views(version_id);
