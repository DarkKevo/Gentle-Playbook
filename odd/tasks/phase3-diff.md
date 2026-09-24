# Feature Tasks: Gentle-Playbook Phase 3 - Diffing & Deduplication

## Overview
Implement the semantic diff and deduplication engine that compares an extracted playbook draft against an existing playbook, identifying new rules, identical rules, conflicts, and supporting rule type conversion (Normativa vs Ask) during merge.

## Tasks
- [x] Task 1: Implement Diff Calculation Engine (`src/core/diff.ts`) - a83092e
- [x] Task 2: Implement Semantic Similarity and Rule Deduplication - a83092e
- [x] Task 3: Implement Playbook Merger with User Resolutions (`mergePlaybooks`) - 2ddf5d5
- [x] Task 4: Author and pass comprehensive test suite (`tests/diff.test.ts`) - 7d12d58
