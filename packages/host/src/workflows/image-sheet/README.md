# image-sheet

A numbered contact sheet of 1 to 24 images, for choosing between candidates: each cell shows the image at 320 px and
again at 64, 32 and 16 px (the sizes a favicon, a tab and a dock are seen at) under a readable number. No model, no cost:
sharp and one bundled font. The same inputs give the same bytes.

```
agw image-sheet /abs/a.png /abs/b.svg /abs/c.webp
agw image-sheet /abs/*.svg --labels ember,tide,moss --ground both --cols 3 --cells
```

Files are absolute paths (png, jpeg, webp or svg by their first bytes, at most 20 MiB each) and are numbered from 1 in
the order given. An SVG is rendered at 1024 px and cut down from there, as `image-icon` does.

|Input|Default|Meaning|
|-|-|-|
|`files`|required|1 to 24 absolute paths, every argument after the verb|
|`labels`|none|`a,b,c`: text after the number, in file order; fewer than files is fine, more is `invalid_input`|
|`ground`|`dark`|`dark`, `light` or `both` (one sheet per ground)|
|`cols`|`4`|Cells per row (at most the file count)|
|`cells`|off|Also one png per cell and ground, to show each option as its own picture|

## Output

`dir` is the run directory in the artifact store. `sheets` lists `sheet-dark.png` and `sheet-light.png` (as asked), each
with its path, size and ground. `cells` is empty without `--cells`, else `cell-NN-<ground>.png` in number order (352x472,
the same tile the sheet is made of). `images` says which file each number is. Each cell is the number, then a plate with
the image at 320 px (a transparent edge shows against it), then the three small sizes bottom-aligned on the ground.

## Decisions

- **The label is drawn with `@napi-rs/canvas` and a font file from `@excalidraw/excalidraw`** (Assistant Bold, the one
  `diagram` already loads). SVG text through sharp would use whatever fonts the machine has: on a host with none the labels
  come out empty, which is how a hand-made sheet once lost its numbers. Registering a font fails loudly instead.
- **One cell is rendered once per ground and reused:** the cell files are the tiles the sheet is composited from, so a cell
  picture and its place on the sheet cannot differ.
- **The command is `image-sheet`**, a word of its own: it is not a prefix of `image` or `image-icon` or the reverse.
- **No scorer and no eval suite:** nothing here is judged, the output is geometry and pixels the tests check.
