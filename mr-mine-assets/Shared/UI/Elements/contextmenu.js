class ContextMenu extends Hitbox {
  root;
  bodyContainer;
  isInitialized = false;
  frameWidth = 12;

  xMin = -1;
  xMax = -1;
  yMin = -1;
  yMax = -1;

  backgroundImage = null;
  popupFrameImage = null;
  closeButtonImage = null;

  constructor(boundingBox, id = "") {
    super(boundingBox, {}, "", id);
    this.initializeFrameImages();
  }

  initializeFrameImages() {
    if (typeof window !== "undefined" && window["popupBackgroundLight"]) {
      const frameSets = getPopupFrameSets();
      this.backgroundImage = frameSets[EARTH_INDEX].backgroundImage;
      this.popupFrameImage = frameSets[EARTH_INDEX].popupFrameImage;
      this.closeButtonImage = frameSets[EARTH_INDEX].closeButtonImage;
    }
  }

  initialize() {
    this.root = this.getRootLayer();
    if (this.root.worldIndex)
      this.setFrameImagesByWorldIndex(this.root.worldIndex);
    var frameWidth = (0.05 * this.boundingBox.width) / uiScaleX;
    var frameHeight = (0.056 * this.boundingBox.height) / uiScaleY;
    var frameRightShadowWidth = (0.017 * this.boundingBox.width) / uiScaleX;
    var frameBottomShadowWidth = (0.03 * this.boundingBox.height) / uiScaleY;
    var closeButtonSize = Math.max(15, frameWidth);
    this.bodyContainer = new Hitbox(
      {
        x: frameWidth,
        y: frameHeight,
        width:
          this.boundingBox.width - (2 * frameWidth + frameRightShadowWidth),
        height:
          this.boundingBox.height - (2 * frameHeight + frameBottomShadowWidth),
      },
      {},
      "",
      "bodyContainer",
    );
    this.addHitbox(this.bodyContainer);
    this.closeButton = this.addHitbox(
      new Button(
        this.closeButtonImage,
        "",
        "",
        "",
        {
          x: this.boundingBox.width - closeButtonSize,
          y: 0,
          width: closeButtonSize,
          height: closeButtonSize,
        },
        {
          onmousedown: function () {
            this.hide();
            this.onHide();
          }.bind(this),
        },
        "pointer",
        "closeButton",
      ),
    );
    this.isInitialized = true;
  }

  render() {
    var context = this.root.context;
    var coords = this.getRelativeCoordinates(0, 0, this.root);
    context.drawImage(
      this.backgroundImage,
      coords.x,
      coords.y,
      this.boundingBox.width,
      this.boundingBox.height,
    );
    this.renderChildren();
    drawFrame(
      context,
      this.popupFrameImage,
      coords.x,
      coords.y,
      this.boundingBox.width,
      this.boundingBox.height,
      this.frameWidth,
    );
    this.closeButton.render();
  }

  show(x, y) {
    if (!this.isInitialized) this.initialize();
    var coords = this.parent.getRelativeCoordinates(x, y, this.root);

    var xMin = 0;
    var xMax = this.root.boundingBox.width;
    var yMin = 0;
    var yMax = this.root.boundingBox.height;
    if (this.xMin >= 0) xMin = this.xMin;
    if (this.xMax >= 0) xMax = this.xMax;
    if (this.yMin >= 0) yMin = this.yMin;
    if (this.yMax >= 0) yMax = this.yMax;

    coords.x = Math.max(
      xMin,
      Math.min(coords.x, xMax - this.boundingBox.width),
    );
    coords.y = Math.max(
      yMin,
      Math.min(coords.y, yMax - this.boundingBox.height),
    );
    var localCoords = this.root.getRelativeCoordinates(
      coords.x,
      coords.y,
      this.parent,
    );
    this.boundingBox.x = localCoords.x;
    this.boundingBox.y = localCoords.y;
    this.setVisible(true);
    this.setEnabled(true);
  }

  hide() {
    this.setVisible(false);
    this.setEnabled(false);
  }

  onHide() {}

  toggle(x, y) {
    if (this.isVisible()) {
      this.hide();
    } else {
      this.show(x, y);
    }
  }

  setFrameImagesByWorldIndex(worldIndex) {
    const frameSets = getPopupFrameSets();
    this.backgroundImage = frameSets[worldIndex].backgroundImage;
    this.popupFrameImage = frameSets[worldIndex].popupFrameImage;
    this.closeButtonImage = frameSets[worldIndex].closeButtonImage;
    this.activeTabImage = frameSets[worldIndex].activeTabImage;
    this.inactiveTabImage = frameSets[worldIndex].inactiveTabImage;
  }
}
