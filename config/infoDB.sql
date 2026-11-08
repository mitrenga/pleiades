SELECT `ndx`, `name`, `score`, `created`
FROM `rg_pl_hallOfFame`
ORDER BY `ndx` DESC
LIMIT :limit
