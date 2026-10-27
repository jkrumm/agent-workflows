|group|cell|prompted / n|timed out|errors|median prompt ms|median location-boot ms|mean CPU % (median)|prompt >45 s (S2 guard)|SIGTERM not honoured in 6 s|SIGKILL ok|log bytes (median)|
|-|-|-|-|-|-|-|-|-|-|-|-|
|recheck|S2 spawn as ran (watchers on)|0/3|3|0|45004|NaN|0|3/3|3/3|3/3|1213|
|recheck|client=curl (watchers on)|0/3|3|0|45170|NaN|0|3/3|3/3|3/3|1213|
|recheck|S2 spawn + OPENCODE_DISABLE_FILEWATCHER=1|3/3|0|0|840|155|49|0/3|0/3|0/0|2169|
|recheck|client=curl + OPENCODE_DISABLE_FILEWATCHER=1|3/3|0|0|593|50|76|0/3|0/3|0/0|2163|
