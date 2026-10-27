// Deliberately wrong: the type-aware rules must flag the floating promise and the misused promise.
async function save(): Promise<void> {}
export function bad(items: string[]) {
  save()
  items.forEach(async () => {
    await save()
  })
  const unused = 1
}
