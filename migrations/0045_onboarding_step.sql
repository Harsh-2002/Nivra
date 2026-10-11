ALTER TABLE instance ADD COLUMN onboarding_step TEXT NOT NULL DEFAULT 'complete' CHECK(onboarding_step IN('tags','install','complete'));
