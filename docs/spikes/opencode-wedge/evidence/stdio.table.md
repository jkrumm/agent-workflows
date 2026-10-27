|group|cell|prompted / n|timed out|errors|median prompt ms|median location-boot ms|mean CPU % (median)|prompt >45 s (S2 guard)|SIGTERM not honoured in 6 s|SIGKILL ok|log bytes (median)|
|-|-|-|-|-|-|-|-|-|-|-|-|
|stdio|stdio=file (watchers on)|0/3|3|0|150020|NaN|0|3/3|3/3|3/3|1514|
|stdio|stdio=file + OPENCODE_DISABLE_FILEWATCHER=1|3/3|0|0|378|49|156|0/3|0/3|0/0|2840|
|stdio|stdio=pipe-unread (watchers on)|0/3|3|0|150003|NaN|0|3/3|3/3|3/3|1253|
|stdio|stdio=pipe-unread + OPENCODE_DISABLE_FILEWATCHER=1|3/3|0|0|391|NaN|75|0/3|0/3|0/0|2192|
|stdio|stdio=pipe-read (watchers on)|0/3|3|0|150003|NaN|0|3/3|3/3|3/3|1870|
|stdio|stdio=pipe-read + OPENCODE_DISABLE_FILEWATCHER=1|3/3|0|0|503|NaN|56|0/3|0/3|0/0|2192|
