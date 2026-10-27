// Diagnostic: a CONNECT/HTTP forward proxy that logs `<t+ms> <event> host:port` to stdout, to see what a cold opencode fetches.
//   bun scripts/connect-log-proxy.ts <port>   then start opencode with HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:<port>
import net from "node:net";
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(String(Date.now() - t0).padStart(6), ...a);
net.createServer((c) => {
  c.once("data", (buf) => {
    const head = buf.toString("latin1");
    const m = /^CONNECT ([^ ]+) HTTP/.exec(head);
    const plain = /^[A-Z]+ http:\/\/([^/ ]+)([^ ]*)/.exec(head);
    const target = m?.[1] ?? (plain ? `${plain[1]}:80` : "");
    if (!target) { c.destroy(); return; }
    const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
    log("open ", target, plain ? `${head.split(" ")[0]} ${plain[1]}${plain[2].slice(0, 50)}` : "");
    const up = net.connect(port, host.replace(/^\[|\]$/g, ""), () => { if (m) c.write("HTTP/1.1 200 Connection Established\r\n\r\n"); else up.write(buf); c.pipe(up); up.pipe(c); });
    const end = (why: string) => () => { log("close", target, why); c.destroy(); up.destroy(); };
    up.on("error", end("upstream-err")); c.on("error", end("client-err")); c.on("close", end("closed"));
  });
}).listen(Number(process.argv[2] ?? 17990), "127.0.0.1");
