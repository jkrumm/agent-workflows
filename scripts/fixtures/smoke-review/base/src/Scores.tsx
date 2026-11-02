import { total } from './stats'

export function Scores({ scores }: { scores: number[] }) {
  return <p>Total: {total(scores)}</p>
}
