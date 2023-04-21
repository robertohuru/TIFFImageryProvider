import { Event, GeographicTilingScheme, Credit, Rectangle, Cartesian3, ImageryLayerFeatureInfo, Math as CMath, DeveloperError } from "cesium";
import GeoTIFF, { Pool, fromUrl as tiffFromUrl, GeoTIFFImage } from 'geotiff';

import { addColorScale, plot } from './plotty'
import WorkerFarm from "./worker-farm";
import { getMinMax, generateColorScale, getRange } from "./utils";
import { ColorScaleNames } from "./plotty/typing";

export interface SingleBandRenderOptions {
  /** band index start from 1, defaults to 1 */
  band?: number;

  /**
   * The color scale image to use.
   */
  colorScaleImage?: HTMLCanvasElement | HTMLImageElement;

  /**
   * The name of a named color scale to use.
   */
  colorScale?: ColorScaleNames;

  /** custom interpolate colors, [stopValue(0 - 1), color] or [color], if the latter, means equal distribution 
   * @example
   * [[0, 'red'], [0.6, 'green'], [1, 'blue']]
  */
  colors?: [number, string][] | string[];

  /** defaults to continuous */
  type?: 'continuous' | 'discrete';

  /**
   * The value domain to scale the color.
   */
  domain?: [number, number];

  /**
   * Range of values that will be rendered, values outside of the range will be transparent.
   */
  displayRange?: [number, number];

  /**
   * Set if displayRange should be used.
   */
  applyDisplayRange?: boolean;

  /**
   * Whether or not values below the domain shall be clamped.
   */
  clampLow?: boolean;

  /**
   * Whether or not values above the domain shall be clamped (if not defined defaults to clampLow value).
   */
  clampHigh?: boolean;
  
  /**
   * Sets a mathematical expression to be evaluated on the plot. Expression can contain mathematical operations with integer/float values, band identifiers or GLSL supported functions with a single parameter.
   * Supported mathematical operations are: add '+', subtract '-', multiply '*', divide '/', power '**', unary plus '+a', unary minus '-a'.
   * Useful GLSL functions are for example: radians, degrees, sin, asin, cos, acos, tan, atan, log2, log, sqrt, exp2, exp, abs, sign, floor, ceil, fract.
   * @param {string} expression Mathematical expression. Example: '-2 * sin(3.1415 - band1) ** 2'
   */
  expression?: string;
}

export interface MultiBandRenderOptions {
  /** Band value starts from 1 */
  r?: {
    band: number;
    min?: number;
    max?: number;
  };
  g?: {
    band: number;
    min?: number;
    max?: number;
  };
  b?: {
    band: number;
    min?: number;
    max?: number;
  };
}

export type TIFFImageryProviderRenderOptions = {
  /** nodata value, default read from tiff meta */
  nodata?: number;
  single?: SingleBandRenderOptions;
  multi?: MultiBandRenderOptions;
}

export interface TIFFImageryProviderOptions {
  url: string;
  credit?: string;
  tileSize?: number;
  maximumLevel?: number;
  minimumLevel?: number;
  enablePickFeatures?: boolean;
  hasAlphaChannel?: boolean;
  renderOptions?: TIFFImageryProviderRenderOptions;
  /** projection function, convert [lon, lat] position to EPSG:4326 */
  projFunc?: (code: number) => (((pos: number[]) => number[]) | void);
  /** cache survival time, defaults to 60 * 3000 ms */
  cache?: number;
}
const canvas = document.createElement('canvas');
export class TIFFImageryProvider {
  ready: boolean;
  tilingScheme: GeographicTilingScheme;
  rectangle: Rectangle;
  tileSize: number;
  tileWidth: number;
  tileHeight: number;
  maximumLevel: number;
  minimumLevel: number;
  credit: Credit;
  private _error: Event;
  readyPromise: Promise<void>;
  private _destroyed = false;
  _source!: GeoTIFF;
  private _imageCount!: number;
  _images: (GeoTIFFImage | null)[] = [];
  _imagesCache: Record<string, {
    time: number;
    data: ImageData | HTMLCanvasElement | HTMLImageElement;
  }> = {};
  bands: Record<number, {
    min: number;
    max: number;
  }>;
  noData: number;
  hasAlphaChannel: boolean;
  private _pool: Pool;
  private _workerFarm: WorkerFarm | null;
  private _cacheTime: number;
  canvas: HTMLCanvasElement;
  plot: plot;
  constructor(private readonly options: TIFFImageryProviderOptions) {
    this.ready = false;
    this.hasAlphaChannel = options.hasAlphaChannel ?? true;
    this.maximumLevel = options.maximumLevel ?? 18;
    this.minimumLevel = options.minimumLevel ?? 0;
    this.credit = new Credit(options.credit || "", false);
    this._error = new Event();

    this._workerFarm = new WorkerFarm();
    this._cacheTime = options.cache ?? 60 * 1000;

    this.readyPromise = tiffFromUrl(options.url, {
      allowFullFile: true
    }).then(async (res) => {
      this._pool = new Pool()
      this._source = res;
      const image = await res.getImage();
      this._imageCount = await res.getImageCount();

      this.tileSize = this.tileWidth = this.tileHeight = options.tileSize || image.getTileWidth() || 512;

      // 获取nodata值
      const noData = image.getGDALNoData();
      this.noData = options.renderOptions.nodata ?? noData;

      const bands: Record<number, {
        min: number;
        max: number;
      }> = {};
      // 获取波段数
      const samples = image.getSamplesPerPixel();
      for (let i = 0; i < samples; i++) {
        // 获取该波段最大最小值信息
        const element = image.getGDALMetadata(i);
        const bandNum = i + 1;

        if (element?.STATISTICS_MINIMUM && element?.STATISTICS_MAXIMUM) {
          bands[bandNum] = {
            min: +element.STATISTICS_MINIMUM,
            max: +element.STATISTICS_MAXIMUM,
          }
        } else {
          const { single, multi } = options.renderOptions ?? {};
          if (multi) {
            const inputBand = multi[Object.keys(multi).find(key => multi[key]?.band === bandNum)]
            if (inputBand?.min !== undefined && inputBand?.max !== undefined) {
              const { min, max } = inputBand
              bands[bandNum] = {
                min, max
              }
            }
          }

          if (single && single.band === bandNum && single.domain) {
            bands[bandNum] = {
              min: single.domain[0],
              max: single.domain[1],
            }
          }

          if (!bands[bandNum]) {
            // 尝试获取波段最大最小值
            console.warn(`Can not get band${bandNum} min/max, try to calculate min/max values, or setting ${single ? 'domain' : 'min / max'}`)
  
            const previewImage = await res.getImage(this._imageCount - 1)
            const data = (await previewImage.readRasters({
              samples: [i],
              pool: this._pool,
            }) as unknown as number[][])[0].filter((item: any) => !isNaN(item))
            bands[bandNum] = getMinMax(data, noData)
          }
        }
      }
      this.bands = bands;

      // 获取空间范围
      const bbox = image.getBoundingBox();
      const [west, south, east, north] = bbox;

      const prjCode = +(image.geoKeys.ProjectedCSTypeGeoKey ?? image.geoKeys.GeographicTypeGeoKey)
      const { projFunc } = options;
      const proj = projFunc?.(prjCode)
      if (typeof proj === 'function') {
        const leftBottom = proj([west, south])
        const rightTop = proj([east, north])
        this.rectangle = Rectangle.fromDegrees(leftBottom[0], leftBottom[1], rightTop[0], rightTop[1])
      } else if (prjCode === 4326) {
        this.rectangle = Rectangle.fromDegrees(...bbox)
      } else if (prjCode === 3857 || prjCode === 900913) {
        this.rectangle = Rectangle.fromCartesianArray([new Cartesian3(west, south), new Cartesian3(east, north)]);
      } else {
        const error = new Error(`Unspported projection type: EPSG:${prjCode}, please add projFunc parameter to handle projection`)
        throw error;
      }
      // 处理跨180度经线的情况
      // https://github.com/CesiumGS/cesium/blob/da00d26473f663db180cacd8e662ca4309e09560/packages/engine/Source/Core/TileAvailability.js#L195
      if (this.rectangle.east < this.rectangle.west) {
        this.rectangle.east += CMath.TWO_PI;
      }
      this.tilingScheme = new GeographicTilingScheme({
        rectangle: this.rectangle,
        numberOfLevelZeroTilesX: 1,
        numberOfLevelZeroTilesY: 1
      });
      this.maximumLevel = this.maximumLevel >= this._imageCount ? this._imageCount - 1 : this.maximumLevel;
      this._images = new Array(this._imageCount).fill(null);
      
      // 如果是单通道渲染, 则构建plot对象
      try {
        if (options.renderOptions?.single) {
          const single = options.renderOptions.single;
          const band = this.bands[single.band ?? 1];
          if (!band) {
            throw new Error(`Invalid band${single.band}`);
          }
          this.plot = new plot({
            canvas,
            ...single,
            domain: single.domain ?? [band.min, band.max]
          })
          this.plot.setNoDataValue(this.noData);
          
          const { expression, colors } = single;
          this.plot.setExpression(expression);
          if (colors) {
            const colorScale = generateColorScale(colors)
            addColorScale('temp', colorScale.colors, colorScale.positions);
            this.plot.setColorScale('temp' as any);
          } else {
            this.plot.setColorScale(single?.colorScale ?? 'blackwhite');
          }
        }
      } catch (e) {
        console.error(e);
        this._error.raiseEvent(e);
      }

      this.ready = true;
    })
  }

  /**
   * Gets an event that will be raised if an error is encountered during processing.
   * @memberof GeoJsonDataSource.prototype
   * @type {Event}
   */
  get errorEvent() {
    return this._error
  }

  get isDestroyed() {
    return this._destroyed
  }

  private _getIndex(level: number) {
    const z = level > this._imageCount ? this._imageCount : level;
    const index = this._imageCount - z - 1;
    return index;
  }

  /**
   * 获取瓦片数据
   * @param x 
   * @param y 
   * @param z 
   */
  private async _loadTile(x: number, y: number, z: number) {
    
    const index = this._getIndex(z);
    let image = this._images[index];
    if (!image) {
      image = this._images[index] = await this._source.getImage(index);
    }
    const width = image.getWidth();
    const height = image.getHeight();
    const tileXNum = this.tilingScheme.getNumberOfXTilesAtLevel(z);
    const tileYNum = this.tilingScheme.getNumberOfYTilesAtLevel(z);
    const tilePixel = {
      xWidth: width / tileXNum,
      yWidth: height / tileYNum
    }
    const pixelBounds = [
      Math.round(x * tilePixel.xWidth),
      Math.round(y * tilePixel.yWidth),
      Math.round((x + 1) * tilePixel.xWidth),
      Math.round((y + 1) * tilePixel.yWidth),
    ];
    
    const promise = image.readRasters({
      window: pixelBounds,
      width: this.tileWidth,
      height: this.tileHeight,
      fillValue: this.noData,
      pool: this._pool,
    })

    return promise
      .then((res) => {
        return {
          data: res as unknown as Float32Array[],
          width: this.tileWidth,
          height: this.tileHeight,
        }
      })
      .catch((error) => {
        this._error.raiseEvent(error);
        throw error;
      });
  }

  async requestImage(
    x: number,
    y: number,
    z: number,
  ) {
    if (!this.ready) {
      throw new DeveloperError(
        "requestImage must not be called before the imagery provider is ready."
      );
    }

    if (z < this.minimumLevel || z > this.maximumLevel || z > this._imageCount) return undefined
    if (this._cacheTime && this._imagesCache[`${x}_${y}_${z}`]) return this._imagesCache[`${x}_${y}_${z}`].data;

    const { renderOptions } = this.options;
    const { single, multi } = renderOptions;

    try {
      const { data, width, height } = await this._loadTile(x, y, z);

      let result: ImageData | HTMLImageElement

      if (single) {
        const { band = 1 } = single;
        this.plot.removeAllDataset();
        data.forEach((dt, index) => {
          this.plot.addDataset(`band${index + 1}`, dt, width, height);
        })
        
        this.plot.renderDataset(`band${band}`)
        this.plot.render();

        const image = new Image();
        
        image.src = this.plot.canvas.toDataURL();

        result = image;
      } else if (multi) {
        const opts = {
          width,
          height,
          renderOptions: multi,
          bands: this.bands,
          noData: this.noData
        }
        if (!this._workerFarm?.worker) {
          throw new Error('web workers bootstrap error');
        }

        result = await this._workerFarm.scheduleTask(data, opts);
      }

      if (result && this._cacheTime) {
        const now = new Date().getTime()
        this._imagesCache[`${x}_${y}_${z}`] = {
          time: now,
          data: result
        };
        for (let key in this._imagesCache) {
          if ((now - this._imagesCache[key].time) > this._cacheTime) {
            delete this._imagesCache[key]
          }
        }
      }
      return result;
    } catch (e) {
      console.error(e);
      this._error.raiseEvent(e);
      throw e;
    }
  }

  async pickFeatures(x: number, y: number, zoom: number, longitude: number, latitude: number) {
    if (!this.options.enablePickFeatures) return undefined

    const z = zoom > this._imageCount ? this._imageCount : zoom;
    const index = this._getIndex(z);
    let image = this._images[index];
    if (!image) {
      image = this._images[index] = await this._source.getImage(index);
    }
    const { west, south, north, width: lonWidth } = this.rectangle;
    const width = image.getWidth();
    const height = image.getHeight();
    let lonGap = longitude - west;
    // 处理跨180°经线的情况
    if (longitude < west) {
      lonGap += CMath.TWO_PI;
    }

    const posX = ~~(Math.abs(lonGap / lonWidth) * width);
    const posY = ~~(Math.abs((north - latitude) / (north - south)) * height);

    const res = await image.readRasters({
      window: [posX, posY, posX + 1, posY + 1],
      height: 1,
      width: 1,
      pool: this._pool,
    })
    const featureInfo = new ImageryLayerFeatureInfo()
    featureInfo.name = `lon:${(longitude / Math.PI * 180).toFixed(6)}, lat:${(latitude / Math.PI * 180).toFixed(6)}`;
    const data = {};
    res?.forEach((item: any, index: number) => {
      data[index] = item?.[0];
    })
    featureInfo.data = data
    if (res) {
      featureInfo.configureDescriptionFromProperties(data)
    }
    return [featureInfo];
  }

  destroy() {
    this._images = undefined;
    this._imagesCache = undefined;
    this._workerFarm?.destory();
    this._pool.destroy();
    this.plot?.destroy();
    this._destroyed = true;
  }
}

export default TIFFImageryProvider;
