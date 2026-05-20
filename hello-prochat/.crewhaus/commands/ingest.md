---
description: Read a document from disk (txt/md/csv/json/yaml — PDF/docx via plugin parser).
argument-hint: "<path>"
---
Ingest the document at: **$ARGUMENTS**

1. Call `IngestDocument({ path: "$ARGUMENTS" })`.
2. The tool returns a structured envelope:
   ```
   <document path="..." name="...">
   metadata: {"ext":"...","size":...,"lines":...}
   ---
   ...content...
   </document>
   ```
3. Read the metadata + content, then offer the user ONE of these next
   actions (don't list all four — pick the most useful given what the
   document looks like):
   - "Want a 3-sentence summary?"
   - "Pull out the key claims with citations?"
   - "Run a query against this — e.g. 'who is X?'"
   - "Convert to a different format?"

If the tool errors with "needs a parser registered" (PDF/docx/xlsx),
explain to the user that they can either:
  a) Convert the file to .txt/.md/.csv first, OR
  b) Register a parser by adding pdf-parse / mammoth / xlsx to their
     deployment (see @crewhaus/tool-document-ingest README).
