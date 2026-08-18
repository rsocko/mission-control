UPDATE `notifications`
SET `category` = 'development'
WHERE `connector_type` = 'github-issues'
  AND `category` <> 'development';
