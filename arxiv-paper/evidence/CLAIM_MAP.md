# Claim-to-evidence map

The study date is 2026-11-13. Observations concern static files, independently tested provenance tools, and source-selected generic data-handling classes in a synthetic namespace. No flight model, trajectory, numerical dynamics, or domain decision algorithm is executed. The current manuscript emphasizes software implementation; the earlier audit manuscript is retained under `../versions/v1-audit/`.

| Manuscript observation | Primary evidence | Interpretation limit |
| --- | --- | --- |
| 23 new generic-interface probes, 21 targeted properties observed | `software_probes.json`, `../scripts/probe_data_contracts.py` | Selected class definitions executed with explicit generic dependencies; not original module imports or application integration. |
| Two stronger diagnostic requirements unenforced | `software_probes.json` | Correctly shaped nonfinite unpack input and a NaN telemetry timestamp are accepted in the isolated Python path. These are proposed stronger requirements, not a claim that an existing formal specification was violated. |
| Generic-class source and line selection | `software_probes.json` under `class_extraction` | Original file digests and selected ranges identify the definitions used; no domain classes or models are loaded. |
| 12 array allocation observations match 8NC bytes | `software_probes.json` under `allocation_experiment` | NumPy float64 payload only; no process RSS, throughput, or full-application performance claim. |
| CPython 3.12.14 / NumPy 2.3.5 for new generic probes | `software_probes.json` under `environment` | Distinct from the older generic-tooling test environment. |
| 85 selected original files | `source_inventory.json` | Explicit subset; includes source, documentation, workflow and report assets, excludes generated output and the new paper folder. Unsigned post-hoc inventory. |
| Source organization and typed state interfaces | Original paths hashed in `source_inventory.json`, particularly `state_schema.py`, `telemetry.py`, `main.py`, `integrator.py` and README files | Static implementation descriptions; not executed numerical or physical validation. |
| 55 simulation Python files | `static_inventory.json` | Includes utilities and tests, not only production modules. |
| 12 simulation test files, 78 definitions | `static_inventory.json` | AST function-definition counts, neither collected-case nor pass counts. |
| Report asset counts 5 / 7 / 1 | `report_audit.json` | Includes each HTML entry point; packaged local assets may include indirectly loaded files. No dynamic JavaScript or external URL audit. |
| All three reports lack matching manifests | `report_audit.json` | Each report's `manifest` is null and status is `legacy_unverified`. |
| No detected local inventory issues | `report_audit.json` | Empty issue arrays only within implemented static scope. Does not prove historical provenance. |
| 48 passed, 1 skipped, 0 failed | `tooling_tests.xml` | One local run of copied generic tooling; XML includes durations, timestamp and case names. No full simulator test result is implied. |
| Platform skip | `tooling_tests.xml` | `test_packaged_asset_symlinks_cannot_escape_root`; directory symlink creation unavailable. This behavior remains untested in this environment. |
| 10/10 probes match expectations | `integrity_probes.json`, `../scripts/probe_tooling.py` | Explicit synthetic cases; not exhaustive correctness, authentication or model validation. |
| Strict report audit exits 1 | `integrity_probes.json` | Observation on original report bundles during this study. This is an evidence-status failure, not a simulated flight failure. |
| CPython 3.11.7, pytest 7.4.0, Windows | `environment.json` | Current capture/tooling environment only. Distribution inventory does not establish simulation compatibility or historical runtime. |
| Intended CI matrix | `.github/workflows/provenance.yml` in selected original inventory | Workflow configuration alone is not an executed CI result. |
| Bibliographic attribution and software-paper positioning | `../references.bib`, `../REVISION_NOTES.zh-CN.md` | Primary software and benchmark papers plus scientific-computing guidance and pytest documentation. The cited libraries are not performance baselines. |
| Source ZIP compiles | `build_check.json` | Local pdfLaTeX/BibTeX build and independent extracted-ZIP build; not a claim of platform acceptance. |

`summary.json` is derived from the earlier tooling records. `../evidence_numbers.tex` retains those headline counts; `../software_numbers.tex` is generated from the new generic-interface run. Four current vector figures are produced by `../scripts/draw_figures.py`: architecture, data contracts, telemetry pipeline, and software evaluation. The current source ZIP includes only the four figures referenced by the manuscript. Older unreferenced figures are retained outside that source ZIP.

The copied generic tools/tests are byte-for-byte copies of the originals as captured in `source_inventory.json` under `copied_generic_tooling`. Their source license is retained at `../reproducibility/LICENSE`. Original simulation code and historical numeric datasets are not included in the paper bundle.

The package-level `../package_manifest.json` preserves current delivered bytes after preparation. Like all unsigned file snapshots, it detects changes relative to the retained reference; it is not an independently authenticated execution history.
