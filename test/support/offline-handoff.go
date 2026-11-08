// Native cross-language test consumer. It writes only the supplied isolated destinations.
package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/CarterShi01/contexture-mcp-go/core/graph"
	"github.com/CarterShi01/contexture-mcp-go/managed"
	"github.com/CarterShi01/contexture-mcp-go/server"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	if len(os.Args) != 6 {
		panic("schema/source/input/fresh-clone/output required")
	}
	schemaBytes, err := os.ReadFile(os.Args[1])
	must(err)
	schema, err := graph.DecodeJSON(schemaBytes)
	must(err)
	options := server.JournalOptions{
		Schema: schema, Durability: "strict",
		Projector: server.GraphJournalProjector(managed.GraphJournalProjectionOptions{}),
	}
	original, err := os.ReadFile(os.Args[3])
	must(err)
	source, err := server.OpenFileJournal(os.Args[2], options)
	must(err)
	watermark, err := source.Watermark()
	must(err)
	if watermark != "1" {
		panic("source watermark differs")
	}
	exported, err := source.ExportSnapshot()
	must(err)
	if !bytes.Equal(exported, original) {
		panic("native TS/Go backup bytes differ")
	}
	receipt, err := source.GetReceipt("tenant-actor", "bootstrap")
	must(err)
	if receipt["journal_seq"] != "1" || receipt["status"] != "committed" {
		panic("source receipt missing")
	}
	sourceID := source.Meta()["store_id"]
	must(source.Close())
	clone, err := server.RestoreFileJournal(os.Args[4], original, options)
	must(err)
	if clone.Meta()["store_id"] == sourceID || clone.Meta()["restored_from"] == nil {
		panic("restore origin is not isolated")
	}
	checkpoint, err := clone.ReadCheckpoint()
	must(err)
	if checkpoint["last_seq"] != "1" {
		panic("restored full checkpoint missing")
	}
	exported, err = clone.ExportSnapshot()
	must(err)
	must(os.WriteFile(os.Args[5], exported, 0600))
	must(clone.Close())
	fmt.Println("NATIVE_TS_GO_OFFLINE_HANDOFF_PASS")
}
