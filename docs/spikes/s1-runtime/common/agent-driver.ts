// The agent step's two halves, with probes. Each candidate journals the handle its own way.
import { agentServer, probe } from "./world.ts";

export async function openSession(runId: string): Promise<string> {
  await probe(runId, "agent.open", "start");
  const id = await agentServer.create(runId, "agent");
  await probe(runId, "agent.open", "end");
  return id;
}

export async function runSession(runId: string, sessionId: string): Promise<string> {
  await agentServer.prompt(sessionId); // no-op when the session was already prompted: re-attach
  await probe(runId, "agent", "start");
  const answer = await agentServer.wait(sessionId);
  await probe(runId, "agent", "end");
  return answer;
}
