# Contributing to WP Real-Time Collaboration

Thank you for your interest in contributing. This plugin is
experimental: settings, filters and stored data can change or go away
between versions. Setup and tests are covered in the
[README](README.md#development).

## Coding standards

All code must follow the
[WordPress Coding Standards and best practices](https://developer.wordpress.org/coding-standards/).

- **WordPress**: The minimum required version is 7.0.
- **PHP**: The minimum required version is 7.4.

## Guidelines

- As with all WordPress projects, we want to ensure a welcoming
  environment for everyone. All contributors are expected to follow the
  [Code of Conduct](https://make.wordpress.org/handbook/community-code-of-conduct/).
- All WordPress projects are [licensed under the GPLv2+](LICENSE), and
  all contributions to this plugin will be released under the GPLv2+
  license. You maintain copyright over any contribution you make, and by
  submitting a pull request, you are agreeing to release that
  contribution under the GPLv2+ license.

## Filing and shaping issues

Open work lives in GitHub Issues.

- **To file an issue you need two things:** what happened, and what you
  expected. The issue arrives with the label `agent:needs shaping`.
- **Someone then investigates and rewrites it** into the shape in
  `.github/ISSUE_TEMPLATE/shaped-issue.md`: what happens now, an
  example with numbered steps, what should happen, how we will know it
  is done, and notes. The label moves to `agent:ready`.
- **One issue is one thing.** Split an issue that holds two problems.
- **Write the title, the problem and the example in plain words.** They
  are read by people who meet this project for the first time. A word
  that `docs/glossary.md` defines is one of our own words: say what it
  means, or move the sentence down into the notes. Code names in
  backticks are always fine.
- **Do not hard-wrap an issue's paragraphs.** GitHub shows every
  newline, so one paragraph is one line.
- `agent:in progress` means someone has claimed the issue.
  `agent:parked` means it cannot move, and a comment says what it needs.

## Use of AI Tools

You are free to use artificial intelligence (AI) tooling to contribute,
but we ask that you disclose what tooling you are using and to what
extent a pull request has been authored by AI. It is your responsibility
to review and take responsibility for what AI generates.

This repo includes an [`AGENTS.md`](AGENTS.md) file, a
[README for agents](https://agents.md/).

For more, please see the
[WordPress AI Guidelines](https://make.wordpress.org/ai/handbook/ai-guidelines/).

## Reporting Security Issues

Please see [SECURITY.md](SECURITY.md).
