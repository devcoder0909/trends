-- Migration 003: Store remote Google Trends image URL & credit (no binary storage)
ALTER TABLE topics ADD COLUMN image_url TEXT NOT NULL DEFAULT '';
ALTER TABLE topics ADD COLUMN image_source TEXT NOT NULL DEFAULT '';
