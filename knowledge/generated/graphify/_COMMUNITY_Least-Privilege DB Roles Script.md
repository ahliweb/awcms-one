---
type: community
cohesion: 1.00
members: 2
---

# Least-Privilege DB Roles Script

**Cohesion:** 1.00 - tightly connected
**Members:** 2 nodes

## Members
- [[01-create-least-privilege-roles.sh]] - code - docker/postgres-init/01-create-least-privilege-roles.sh
- [[01-create-least-privilege-roles.sh script]] - code - docker/postgres-init/01-create-least-privilege-roles.sh

## Live Query (requires Dataview plugin)

```dataview
TABLE source_file, type FROM #community/Least-Privilege_DB_Roles_Script
SORT file.name ASC
```
