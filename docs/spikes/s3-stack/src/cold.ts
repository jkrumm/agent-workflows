export {}

// Cold start of one candidate: import, build the app, emit the OpenAPI document. Run as a fresh process.
const fw = await import(`./${process.argv[2]}.ts`)
await fw.spec()
