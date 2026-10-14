# 3D Relief Map

Pick a rectangle on the world map and export a printable 3D relief model of it,
split into colour bands for multi-colour printing.

## Run

No build step and no dependencies to install (libraries are in `vendor/`).
The page needs to be served over HTTP and needs internet access for map and
elevation tiles.

    npm start            # same as: python3 serve.py 5173 (no-cache headers)

Then open http://localhost:5173.

    npm test             # checks that every generated part is a closed solid

## How it works

- **Area** – drag the corner handles or the centre dot, use *Draw area* to drag a
  new rectangle, or *Select visible*. The search box jumps to a place.
- **Model** – size of the longest side, total model height (field or slider, at
  most a quarter of the longest side; sets the number of relief layers),
  sampling detail, smoothing and how the sea is treated (flat with its own
  colour, flat, or with the seabed).
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
- **Colors** – 1 to 8 colours, by *height*, *steepness*, *natural (satellite)*
  or *street map (land cover)*. Palettes include *Topographic* (blue water,
  green to brown land).
  - Height: split by equal height or equal area. Every colour starts on a whole
    layer; the list shows the layer range of each colour.
  - Steepness: each grid triangle is coloured by the real terrain slope
    (flattest first, *Steepness* palette), split into equal degree steps (up to
    the 98th percentile) or equal area. Each colour is a closed column solid
    standing on the base plate, so this needs a multi-material printer.
  - Natural (satellite): the satellite image under each triangle, reduced to
    the chosen number of colours (k-means in Lab space); the swatches take the
    real image colours. Columns as for steepness.
  - Street map (land cover): forest, farmland, grass, wetland, rock and sand,
    ice, built-up areas and major roads from OpenStreetMap, in fixed colours.
    With fewer colours than categories the rarest become open land. Roads are
    only drawn when a grid sample covers 250 m or less. Columns as for steepness.
- **Export**
  - `3MF` – one file, one coloured part per filament (multi-material printers).
  - `STL single body` – one solid; on a single-nozzle printer add filament
    changes at the layers listed under *Colors*.
  - `STL per color` – zip with one STL per colour and `filament-plan.txt`.
  - `OBJ + MTL` – zip, one object and material per colour.

## Notes

- Elevation comes from the public Terrarium terrain tiles (Mapzen, hosted on AWS
  Open Data), fetched at up to zoom 14.
- Satellite imagery comes from Esri World Imagery.
- Lake, river and land cover outlines come from the public OpenFreeMap vector tiles
  (OpenMapTiles schema, OpenStreetMap data). Small lakes and minor rivers drop
  out when a large area is selected; streams are never included.
- Anything at or below 0 m counts as sea in the "flat" sea modes, so land below
  sea level is flattened too. Use *Show seabed* for such areas.
- Layer numbers assume the first layer has the same height as the others.

## Layout

    src/elevation.js   tile download and resampling
    src/curve.js       height curve maths and editor
    src/water.js       lake, river and land cover download (vector tiles) and rasterising
    src/imagery.js     satellite imagery download, averaged onto the grid
    src/heightmap.js   elevation + settings -> heights (mm) and colour bands
    src/mesher.js      heights -> closed solid per band
    src/exporters.js   STL / 3MF / OBJ writers
    src/map.js         Leaflet map and rectangle selection
    src/preview.js     three.js preview
    src/main.js        UI wiring
