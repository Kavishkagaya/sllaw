// Creates the Zilliz collection for users' files, with its metadata indexes, before the first insert (#19).
// pnpm --filter @sllaw/search files-collection        (fails if it exists)
import { FILES } from "../src/files";
import { zilliz } from "../src/zilliz";

const vc = (fieldName: string, max_length: number) => ({
  fieldName,
  dataType: "VarChar",
  elementTypeParams: { max_length },
});

await zilliz("collections/create", {
  collectionName: FILES,
  schema: {
    autoId: false,
    enableDynamicField: false,
    fields: [
      { ...vc("id", 64), isPrimary: true }, // <fileId>:<n>
      { fieldName: "vec", dataType: "FloatVector", elementTypeParams: { dim: 1024 } },
      { fieldName: "sparse", dataType: "SparseFloatVector" },
      // standard analyzer, not english: case files mix Sinhala, Tamil and English
      {
        fieldName: "text",
        dataType: "VarChar",
        elementTypeParams: { max_length: 65535, enable_analyzer: true, analyzer_params: { type: "standard" } },
      },
      vc("file_id", 36),
      { fieldName: "n", dataType: "Int32" },
      { fieldName: "page", dataType: "Int32" },
      vc("workspace_id", 36),
      {
        fieldName: "scopes",
        dataType: "Array",
        elementDataType: "VarChar",
        elementTypeParams: { max_capacity: 64, max_length: 48 },
      },
    ],
    functions: [{ name: "bm25", type: "BM25", inputFieldNames: ["text"], outputFieldNames: ["sparse"] }],
  },
  indexParams: [
    { fieldName: "vec", indexName: "vec", metricType: "COSINE", params: { index_type: "AUTOINDEX" } },
    { fieldName: "sparse", indexName: "sparse", metricType: "BM25", params: { index_type: "AUTOINDEX" } },
    ...["workspace_id", "file_id", "scopes"].map((f) => ({
      fieldName: f,
      indexName: f,
      params: { index_type: "AUTOINDEX" },
    })),
  ],
});
console.log(`created ${FILES}`);
