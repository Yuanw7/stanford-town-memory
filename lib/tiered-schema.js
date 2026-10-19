// Decoding constraints do not establish semantic truth; validateExtraction still
// checks the source, literal value, participants, dates and acceptance boundary.
const string = { type: 'string' };
const { mentionedDates } = require('./query-plan');
const { datedEvidence } = require('./temporal-evidence');
const { referenceEvidence } = require('./reference-extraction');
const source = { type: 'array', minItems: 1, items: string };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const extractionSchema = object({ records: { type: 'array', maxItems: 8, items: { anyOf: [
  object({ kind: { const: 'fact' }, subject: string, predicate: string, value: string,
    validFrom: { type: ['string', 'null'] }, validUntil: { type: ['string', 'null'] },
    replacesPrior: { type: 'boolean' }, sourceEventIds: source, quote: string }),
  object({ kind: { const: 'commitment' }, actor: string, action: { const: 'deliver' }, item: string,
    recipient: string, dueAt: string, sourceEventIds: source, quote: string }),
] } } });
function sourceSentenceSchema(conversation) {
  const schema = structuredClone(extractionSchema);
  const [fact, commitment] = schema.properties.records.items.anyOf;
  // Couple value, quote and source in the same branch; independent enums allow
  // valid strings to be combined into an invalid provenance claim.
  const facts = conversation.messages.filter(m => m.text.trim().length >= 5).map(message => {
    const branch = structuredClone(fact), fields = branch.properties;
    fields.value = { type: 'string', enum: [...new Set([message.text, ...message.text.split(/(?<=[.!?。！？])\s+/)].filter(text => text.trim().length >= 5))] };
    fields.quote = { type: 'string', enum: [message.text] };
    fields.sourceEventIds = { type: 'array', minItems: 1, maxItems: 1, items: { type: 'string', enum: [message.id] } };
    return branch;
  });
  commitment.properties.sourceEventIds.items = { type: 'string', enum: conversation.messages.map(m => m.id) };
  schema.properties.records.items.anyOf = [...facts, commitment];
  return schema;
}
function queryPlanSchema(question) {
  return object({ asOfDate: { enum: [null, ...mentionedDates(question)] }, focus: { type: 'string', enum: ['fact', 'commitment', 'any'] } });
}
function datedSentenceSchema(conversation) {
  const schema = structuredClone(extractionSchema), [fact, commitment] = schema.properties.records.items.anyOf;
  const facts = datedEvidence(conversation).candidates.map(candidate => {
    const branch = structuredClone(fact), f = branch.properties;
    for (const key of ['validFrom', 'validUntil', 'replacesPrior']) f[key] = { const: candidate[key] };
    f.value = { const: candidate.quote }; f.quote = { const: candidate.quote };
    f.sourceEventIds = { type: 'array', minItems: 1, maxItems: 1, items: { const: candidate.sourceEventId } };
    return branch;
  });
  commitment.properties.sourceEventIds.items = { type: 'string', enum: conversation.messages.map(m => m.id) };
  schema.properties.records.items.anyOf = [...facts, commitment]; return schema;
}
function referenceSentenceSchema(conversation) {
  const properties = Object.fromEntries(referenceEvidence(conversation).map(e => [e.id, object({ subject: string, predicate: string })]));
  const commitment = structuredClone(extractionSchema.properties.records.items.anyOf[1]);
  commitment.properties.sourceEventIds.items = { type: 'string', enum: conversation.messages.map(m => m.id) };
  return object({ facts: { type: 'object', properties, additionalProperties: false },
    commitments: { type: 'array', maxItems: 4, items: commitment } });
}
module.exports = { extractionSchema, sourceSentenceSchema, queryPlanSchema, datedSentenceSchema, referenceSentenceSchema };
