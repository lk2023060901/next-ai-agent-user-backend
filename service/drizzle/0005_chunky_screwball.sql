ALTER TABLE `agents` ADD `model_id` text REFERENCES ai_models(id);
--> statement-breakpoint

-- Backfill agents.model_id from legacy agents.model (model name) when mapping is unambiguous.
UPDATE `agents`
SET `model_id` = (
  SELECT m.id
  FROM `ai_models` m
  JOIN `ai_providers` p ON p.id = m.provider_id
  WHERE p.workspace_id = `agents`.workspace_id
    AND m.name = `agents`.model
  LIMIT 1
)
WHERE `model_id` IS NULL
  AND `model` IS NOT NULL
  AND LENGTH(TRIM(`model`)) > 0
  AND (
    SELECT COUNT(*)
    FROM `ai_models` m2
    JOIN `ai_providers` p2 ON p2.id = m2.provider_id
    WHERE p2.workspace_id = `agents`.workspace_id
      AND m2.name = `agents`.model
  ) = 1;
--> statement-breakpoint

-- If multiple models share the same name, backfill only when there is exactly one default.
UPDATE `agents`
SET `model_id` = (
  SELECT m.id
  FROM `ai_models` m
  JOIN `ai_providers` p ON p.id = m.provider_id
  WHERE p.workspace_id = `agents`.workspace_id
    AND m.name = `agents`.model
    AND m.is_default = 1
  LIMIT 1
)
WHERE `model_id` IS NULL
  AND `model` IS NOT NULL
  AND LENGTH(TRIM(`model`)) > 0
  AND (
    SELECT COUNT(*)
    FROM `ai_models` m2
    JOIN `ai_providers` p2 ON p2.id = m2.provider_id
    WHERE p2.workspace_id = `agents`.workspace_id
      AND m2.name = `agents`.model
  ) > 1
  AND (
    SELECT COUNT(*)
    FROM `ai_models` m3
    JOIN `ai_providers` p3 ON p3.id = m3.provider_id
    WHERE p3.workspace_id = `agents`.workspace_id
      AND m3.name = `agents`.model
      AND m3.is_default = 1
  ) = 1;
