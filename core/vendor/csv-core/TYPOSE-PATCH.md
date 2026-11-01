# csv-core 0.1.13 clone correction

Upstream crate archive SHA-256: `704a3c26996a80471189265814dbc2c257598b96b8a7feae2d31ace646bb9782`.

Only parser change: derive `Clone` on `Dfa` and `DfaClasses`, replacing incomplete manual implementations. The former copied only `trans`, losing `has_output`, byte classes and final/state discriminants; the latter lost `next_class`. `Reader` keeps its existing derived Clone. No unsafe copying, grammar change or dependency update.

Original licenses and package metadata are retained. Planned focused CSV checkpoint tests will check independent clones inside quoted fields, doubled quotes and partial output buffers; qualification must record their observed result before claiming coverage.
