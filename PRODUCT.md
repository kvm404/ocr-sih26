# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user for the SIH demo is a Legal Metrology inspector (or a team member playing that role) who photographs a physical packaged commodity and needs a reviewable inspection record. Secondary audience is SIH 2026 judges evaluating Problem Statement 26034.

## Product Purpose

NyayaPack is an inspection aid. It extracts label declarations from package photographs, checks them against a supported Legal Metrology (Packaged Commodities) Rules, 2011 set, and produces a report a reviewer can correct and confirm. Success is an honest, evidence-linked record, not legal certification.

## Positioning

One inspection is one physical package with several photographs. A local vision model proposes observations tied to those photographs. Explicit rules decide only supported, applicable checks. A human reviewer confirms coverage, corrections, and the report. The app does not invent missing text or treat unassessed checks as passes.

## Operating Context

The core demo runs on one laptop: this Next.js app plus Qwen3-VL-4B served by LM Studio at `http://localhost:1234/v1`. Storage is browser-only. There is no login, no server database, and no remote deployment requirement.

## Capabilities and Constraints

- Upload multiple photographs of one package, run analysis, review observations and suspected violations, confirm, export PDF/DOCX, and browse real inspection history.
- Headlines use "no issue found," "suspected violation," and "not assessed" / insufficient evidence. A numeric score is an internal test measure, not a public compliance claim.
- The product is a prototype for Smart India Hackathon 2026, Problem Statement 26034. Not for enforcement use.
- Terminology follows CONTEXT.md: package photograph, inspection, reviewer, observed declaration, reviewed declaration, not assessed, suspected violation.

## Brand Commitments

- Name: NyayaPack. Tagline in the supplied landing mock: "see. verify. ensure."
- Landing copy and composition are pinned by the user-supplied mock (SIH 2026 header, inspection-card hero, five-step workflow, declaration coverage, three result states).
- Do not claim enforcement authority, certification, or fabricated scan volumes.

## Evidence on Hand

- User-supplied landing mock for the marketing page.
- No real customer testimonials or production usage stats. Hero inspection card is a labelled sample (`#NYP-2026-0017`) used to demonstrate the product, not a live saved inspection.

## Product Principles

1. Show evidence, not scores, as the public result.
2. Human review sits in the middle of the workflow, never as a footnote.
3. Unassessed is a first-class outcome.
4. Keep SIH/DoCA context visible without pretending this is a government product in production.
5. Do not fabricate activity, customers, or legal conclusions.

## Accessibility & Inclusion

Public web prototype. Keyboard-reachable navigation and contrast that holds on white marketing surfaces and the navy SIH bar. No product-specific AT requirement beyond that was recorded.
