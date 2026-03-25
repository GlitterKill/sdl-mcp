/**
 * Symptom type classification for retrieval evidence.
 *
 * Classifies the primary symptom type from slice/agent request inputs
 * to enrich retrieval evidence with workflow context.
 */

/**
 * Classify the primary symptom type from slice build request inputs.
 * Priority: stackTrace > failingTest > editedFiles > taskText
 */
export function classifySymptomType(inputs: {
  stackTrace?: string;
  failingTestPath?: string;
  editedFiles?: string[];
  taskText?: string;
}): "stackTrace" | "failingTest" | "taskText" | "editedFiles" {
  if (inputs.stackTrace) return "stackTrace";
  if (inputs.failingTestPath) return "failingTest";
  if (inputs.editedFiles && inputs.editedFiles.length > 0) return "editedFiles";
  return "taskText";
}
