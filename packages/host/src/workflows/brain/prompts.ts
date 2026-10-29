export const brainTask = (question: string) => `## Question\n\n${question.trim()}\n\nAnswer with the JSON object only.`

export const JSON_ONLY_REASK =
  'Your last answer was not the JSON object the instructions ask for. Answer again with ONLY that JSON object ' +
  '({"found", "answer", "citations"}), no prose and no code fence around it.'
