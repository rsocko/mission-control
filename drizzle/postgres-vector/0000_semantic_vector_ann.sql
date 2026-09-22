CREATE TABLE "semantic_vector_ann" (
  "vector_id" text PRIMARY KEY NOT NULL,
  "index_id" text NOT NULL,
  "document_id" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text NOT NULL,
  "sensitivity" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dimensions" integer NOT NULL,
  "embedding" vector NOT NULL,
  "source_revision" text NOT NULL,
  "source_updated_at" text NOT NULL,
  "embedded_at" text NOT NULL,
  "expires_at" text,
  "retain_until" text,
  CONSTRAINT "semantic_vector_ann_embedding_dimensions_check"
    CHECK ("dimensions" BETWEEN 1 AND 4000 AND vector_dims("embedding") = "dimensions"),
  CONSTRAINT "semantic_vector_ann_vector_id_semantic_vectors_id_fk"
    FOREIGN KEY ("vector_id") REFERENCES "public"."semantic_vectors"("id") ON DELETE cascade,
  CONSTRAINT "semantic_vector_ann_index_id_semantic_index_identities_id_fk"
    FOREIGN KEY ("index_id") REFERENCES "public"."semantic_index_identities"("id") ON DELETE cascade,
  CONSTRAINT "semantic_vector_ann_document_id_semantic_documents_id_fk"
    FOREIGN KEY ("document_id") REFERENCES "public"."semantic_documents"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_semantic_vector_ann_entity"
  ON "semantic_vector_ann" USING btree ("index_id", "entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX "idx_semantic_vector_ann_filters"
  ON "semantic_vector_ann" USING btree ("index_id", "entity_type", "sensitivity");
--> statement-breakpoint
CREATE INDEX "idx_semantic_vector_ann_expiry"
  ON "semantic_vector_ann" USING btree ("index_id", "expires_at", "retain_until");
