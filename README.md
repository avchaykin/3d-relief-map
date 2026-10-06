# 3D Relief Map

Pick a rectangle on the world map and export a printable 3D relief model of it,
split into colour bands for multi-colour printing.

## Run

No build step and no dependencies to install (libraries are in `vendor/`).
The page needs to be served over HTTP and needs internet access for map and
elevation tiles.

    npm start            # same as: python3 -m http.server 5173

Then open http://localhost:5173.

    npm test             # checks that every generated part is a closed solid

## How it works

- **Area** – drag the corner handles or the centre dot, use *Draw area* to drag a
  new rectangle, or *Select visible*. The search box jumps to a place.
- **Model** – size of the longest side, sampling detail, smoothing and how the sea
  is treated (flat with its own colour, flat, or with the seabed).
- **Lakes and rivers** – optional. Their outlines come from OpenStreetMap and are
  inlaid into the surface in the water colour (first palette colour), a few
  layers deep, at whatever height they lie. Because they are not tied to a layer
  range they need a multi-material printer (3MF or STL per colour); the
  single-body STL contains no separate water. River width and inlay depth are
  adjustable.
- **Height curve** – like Curves/Levels in an image editor: map elevation on the
  horizontal axis, model height on the vertical one, with a histogram of the
  terrain behind it. Drag points, click to add, double-click to remove; pull the
  end points inwards to clip the lowest or highest terrain.
- **Print settings** – layer height, number of relief layers and base thickness.
  Relief height is `layers × layer height`; the panel shows the resulting size,
  map scale and vertical exaggeration.
- **Colors** – 1 to 8 colours, split by equal height or equal area. Every colour
  starts on a whole layer; the list shows the layer range of each colour.
- **Export**
  - `3MF` – one file, one coloured part per filament (multi-material printers).
  - `STL single body` – one solid; on a single-nozzle printer add filament
    changes at the layers listed under *Colors*.
  - `STL per color` – zip with one STL per colour and `filament-plan.txt`.
  - `OBJ + MTL` – zip, one object and material per colour.

## Notes

- Elevation comes from the public Terrarium terrain tiles (Mapzen, hosted on AWS
  Open Data), fetched at up to zoom 14.
- Lake and river outlines come from the public OpenFreeMap vector tiles
  (OpenMapTiles schema, OpenStreetMap data). Small lakes and minor rivers drop
  out when a large area is selected; streams are never included.
- Anything at or below 0 m counts as sea in the "flat" sea modes, so land below
  sea level is flattened too. Use *Show seabed* for such areas.
- Layer numbers assume the first layer has the same height as the others.

## Layout

    src/elevation.js   tile download and resampling
    src/curve.js       height curve maths and editor
    src/water.js       lake and river download (vector tiles) and rasterising
    src/heightmap.js   elevation + settings -> heights (mm) and colour bands
    src/mesher.js      heights -> closed solid per band
    src/exporters.js   STL / 3MF / OBJ writers
    src/map.js         Leaflet map and rectangle selection
    src/preview.js     three.js preview
    src/main.js        UI wiring
