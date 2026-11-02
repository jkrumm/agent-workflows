import { average, total } from './stats'

export function Scores({ scores, notes }: { scores: number[]; notes: string[] }) {
  return (
    <section>
      <p>Total: {total(scores)}</p>
      <p>Average: {average(scores)}</p>
      <ul>
        {notes.map((note) => (
          <li dangerouslySetInnerHTML={{ __html: note }} />
        ))}
      </ul>
    </section>
  )
}
