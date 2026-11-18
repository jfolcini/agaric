# Session 4343 — page header's property select reads definitions through the shared query

Fix #6946: `PagePropertyTable` read the space's property definitions in a plain `useEffect`, outside `propertyDefsQueryKey`, so `invalidatePropertyCaches()` and the change feed (#6545) never refreshed the header's select.
