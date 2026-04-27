import { Alert, Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { PDFDocument } from "pdf-lib";

import { BookmarkTypes, ZBookmark } from "@karakeep/shared/types/bookmarks";

import { useToast } from "@/components/ui/Toast";
import type { Settings } from "@/lib/settings";
import { buildApiHeaders } from "@/lib/utils";

type ToastFn = ReturnType<typeof useToast>["toast"];

const pdfShareOptions = {
  mimeType: "application/pdf",
  UTI: "com.adobe.pdf",
};

function pdfFileName(fileName: string | null | undefined, fallback: string) {
  const rawName = fileName?.trim() || fallback;
  return rawName.endsWith(".pdf") ? rawName : `${rawName}.pdf`;
}

function showShareError(toast: ToastFn, message = "Failed to share") {
  toast({
    message,
    variant: "destructive",
    showProgress: false,
  });
}

export async function setPdfTitle(fileUri: string, title: string) {
  const base64 = await FileSystem.readAsStringAsync(fileUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const pdfDoc = await PDFDocument.load(
    Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
  );
  pdfDoc.setTitle(title);
  const modified = await pdfDoc.saveAsBase64();
  await FileSystem.writeAsStringAsync(fileUri, modified, {
    encoding: FileSystem.EncodingType.Base64,
  });
}

async function downloadAsset(
  settings: Settings,
  assetId: string,
  fileName: string,
) {
  const assetUrl = `${settings.address}/api/assets/${assetId}`;
  const fileUri = `${FileSystem.documentDirectory}${fileName}`;
  const downloadResult = await FileSystem.downloadAsync(assetUrl, fileUri, {
    headers: buildApiHeaders(settings.apiKey, settings.customHeaders),
  });

  if (downloadResult.status !== 200) {
    throw new Error("Failed to download file");
  }

  return downloadResult.uri;
}

async function sharePdfAsset({
  settings,
  assetId,
  fileName,
  title,
}: {
  settings: Settings;
  assetId: string;
  fileName: string;
  title?: string | null;
}) {
  const fileUri = await downloadAsset(settings, assetId, fileName);
  try {
    if (title) {
      await setPdfTitle(fileUri, title);
    }
    await Sharing.shareAsync(fileUri, pdfShareOptions);
  } finally {
    await FileSystem.deleteAsync(fileUri, {
      idempotent: true,
    });
  }
}

function sharePdfWithErrorToast(sharePdf: () => Promise<void>, toast: ToastFn) {
  void sharePdf().catch((error) => {
    console.error("Share PDF error:", error);
    showShareError(toast, "Failed to share PDF");
  });
}

export async function shareBookmark(
  bookmark: ZBookmark,
  settings: Settings,
  toast: ToastFn,
) {
  try {
    switch (bookmark.content.type) {
      case BookmarkTypes.LINK: {
        const url = bookmark.content.url;
        const title = bookmark.title ?? bookmark.content.title;
        const pdfAsset = bookmark.assets.find((a) => a.assetType === "pdf");

        if (pdfAsset && (await Sharing.isAvailableAsync())) {
          Alert.alert("Share", "How would you like to share this bookmark?", [
            { text: "Cancel", style: "cancel" },
            {
              text: "Share URL",
              onPress: () => void Share.share({ url, message: url }),
            },
            {
              text: "Share PDF",
              onPress: () =>
                sharePdfWithErrorToast(
                  () =>
                    sharePdfAsset({
                      settings,
                      assetId: pdfAsset.id,
                      fileName: pdfFileName(
                        pdfAsset.fileName,
                        title || "document",
                      ),
                      title,
                    }),
                  toast,
                ),
            },
          ]);
          break;
        }

        await Share.share({
          url,
          message: url,
        });
        break;
      }

      case BookmarkTypes.TEXT:
        await Clipboard.setStringAsync(bookmark.content.text);
        toast({
          message: "Text copied to clipboard",
          showProgress: false,
        });
        break;

      case BookmarkTypes.ASSET: {
        const content = bookmark.content;

        if (content.assetType !== "image" && content.assetType !== "pdf") {
          toast({
            message: "Sharing is not available for this file type",
            variant: "destructive",
            showProgress: false,
          });
          break;
        }

        const canShare = await Sharing.isAvailableAsync();

        if (content.assetType === "pdf") {
          const assetId = content.assetId;
          const contentFileName = content.fileName;
          const sourceUrl = content.sourceUrl;
          const sharePdf = async () => {
            if (!canShare) {
              toast({
                message: "Sharing is not available for this file type",
                variant: "destructive",
                showProgress: false,
              });
              return;
            }

            await sharePdfAsset({
              settings,
              assetId,
              fileName: pdfFileName(contentFileName, "document"),
              title: bookmark.title,
            });
          };

          if (sourceUrl) {
            Alert.alert("Share", "How would you like to share this PDF?", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Share URL",
                onPress: () =>
                  void Share.share({ url: sourceUrl, message: sourceUrl }),
              },
              {
                text: "Share PDF",
                onPress: () => sharePdfWithErrorToast(sharePdf, toast),
              },
            ]);
          } else {
            await sharePdf();
          }

          break;
        }

        if (!canShare) {
          toast({
            message: "Sharing is not available for this file type",
            variant: "destructive",
            showProgress: false,
          });
          break;
        }

        const fileUri = await downloadAsset(
          settings,
          content.assetId,
          "temp_image.jpg",
        );
        try {
          await Sharing.shareAsync(fileUri);
        } finally {
          await FileSystem.deleteAsync(fileUri, {
            idempotent: true,
          });
        }
        break;
      }
    }
  } catch (error) {
    console.error("Share error:", error);
    showShareError(toast);
  }
}
