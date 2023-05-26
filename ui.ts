console.log('im here!')

// import JSZip from "./node_modules/jszip/dist/jszip";

// console.log(JSZip);

// function typedArrayToBuffer(array) {
//   return array.buffer.slice(array.byteOffset, array.byteLength + array.byteOffset);
// }



// window.onmessage = async (event) => {
//   if (!event.data.pluginMessage) return;

//   const { exportableBytes } = event.data.pluginMessage;

//   return new Promise((resolve) => {
//     let zip = new JSZip();

//     for (let data of exportableBytes) {
//       const { bytes } = data;
//       const cleanBytes = typedArrayToBuffer(bytes);
//       let blob = new Blob([cleanBytes]);
//       zip.file(`name`, blob, { base64: true });
//     }

//     zip.generateAsync({ type: "blob" }).then((content: Blob) => {
//       const blobURL = window.URL.createObjectURL(content);
//       const link = document.createElement("a");
//       link.className = "button button--primary";
//       link.href = blobURL;
//       link.download = "export.zip";
//       link.click();
//       link.setAttribute("download", name + ".zip");
//       resolve();
//     });
//   }).then(() => {
//     window.parent.postMessage({ pluginMessage: "Done!" }, "*");
//   });
// };
