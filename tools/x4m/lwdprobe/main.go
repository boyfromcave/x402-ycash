// lwdprobe: read-only measurements against a lightwalletd (x402 X4-M, agent sync cost).
//
//	lwdprobe [-addr host:port] [-tls] info
//	lwdprobe ... tree <height>                 Sapling commitment-tree size (= Sapling outputs so far)
//	lwdprobe ... range <start> <end> [dump]    stream compact blocks; bytes, txs, outputs; optional dump
//
// The dump is the compact Sapling outputs, one 164-byte record each:
// height u32le | txindex u32le | outindex u32le | pad u32 | txid[32] | cmu[32] | epk[32] | ct[52]
// (the layout the Rust trial-decryption bench reads).
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"time"

	"github.com/golang/protobuf/proto"
	pb "github.com/zcash/lightwalletd/walletrpc"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:9067", "lightwalletd host:port")
	useTLS := flag.Bool("tls", false, "use TLS")
	flag.Parse()
	opts := []grpc.DialOption{grpc.WithBlock(), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(64 << 20))}
	if *useTLS {
		opts = append(opts, grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{})))
	} else {
		opts = append(opts, grpc.WithInsecure())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	dctx, dcancel := context.WithTimeout(ctx, 20*time.Second)
	defer dcancel()
	conn, err := grpc.DialContext(dctx, *addr, opts...)
	if err != nil {
		log.Fatalf("dial %s: %v", *addr, err)
	}
	defer conn.Close()
	c := pb.NewCompactTxStreamerClient(conn)
	args := flag.Args()
	if len(args) == 0 {
		log.Fatal("need a command: info | tree <h> | range <a> <b> [dump]")
	}
	switch args[0] {
	case "info":
		info, err := c.GetLightdInfo(ctx, &pb.Empty{})
		must(err)
		out(info)
	case "tree":
		h := atoi(args[1])
		ts, err := c.GetTreeState(ctx, &pb.BlockID{Height: h})
		must(err)
		size, err := saplingTreeSize(ts.Tree)
		must(err)
		out(map[string]interface{}{"height": ts.Height, "time": ts.Time, "hash": ts.Hash, "saplingTreeSize": size})
	case "range":
		a, b := atoi(args[1]), atoi(args[2])
		var dump *bufio.Writer
		if len(args) > 3 {
			f, err := os.Create(args[3])
			must(err)
			defer f.Close()
			dump = bufio.NewWriter(f)
			defer dump.Flush()
		}
		start := time.Now()
		stream, err := c.GetBlockRange(ctx, &pb.BlockRange{Start: &pb.BlockID{Height: a}, End: &pb.BlockID{Height: b}})
		must(err)
		var blocks, txs, outputs, spends, bytes, outBytes int
		for {
			blk, err := stream.Recv()
			if err == io.EOF {
				break
			}
			must(err)
			blocks++
			bytes += proto.Size(blk)
			for _, tx := range blk.Vtx {
				txs++
				spends += len(tx.Spends)
				for i, o := range tx.Outputs {
					outputs++
					outBytes += proto.Size(o)
					if dump != nil {
						var rec [164]byte
						binary.LittleEndian.PutUint32(rec[0:], uint32(blk.Height))
						binary.LittleEndian.PutUint32(rec[4:], uint32(tx.Index))
						binary.LittleEndian.PutUint32(rec[8:], uint32(i))
						copy(rec[16:48], tx.Hash)
						copy(rec[48:80], o.Cmu)
						copy(rec[80:112], o.Epk)
						copy(rec[112:164], o.Ciphertext)
						dump.Write(rec[:])
					}
				}
			}
		}
		el := time.Since(start)
		out(map[string]interface{}{
			"start": a, "end": b, "blocks": blocks, "txs": txs, "outputs": outputs, "spends": spends,
			"protoBytes": bytes, "outputProtoBytes": outBytes, "seconds": el.Seconds(),
		})
	default:
		log.Fatalf("unknown command %q", args[0])
	}
}

// saplingTreeSize parses zcashd's serialized IncrementalMerkleTree (Optional left, Optional right,
// vector<Optional> parents) and returns its size, which is the number of Sapling note commitments
// appended so far (zcashd src/zcash/IncrementalMerkleTree.cpp, size()).
func saplingTreeSize(hexTree string) (uint64, error) {
	b, err := hex.DecodeString(hexTree)
	if err != nil {
		return 0, err
	}
	p := 0
	opt := func() (bool, error) {
		if p >= len(b) {
			return false, fmt.Errorf("short tree")
		}
		flag := b[p]
		p++
		if flag == 1 {
			p += 32
			return true, nil
		}
		return false, nil
	}
	var size uint64
	for i := 0; i < 2; i++ {
		ok, err := opt()
		if err != nil {
			return 0, err
		}
		if ok {
			size++
		}
	}
	// compactsize count (trees have depth 32, so one byte suffices)
	n := int(b[p])
	p++
	for i := 0; i < n; i++ {
		ok, err := opt()
		if err != nil {
			return 0, err
		}
		if ok {
			size += 1 << uint(i+1)
		}
	}
	return size, nil
}

func atoi(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 64)
	must(err)
	return v
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func out(v interface{}) {
	j, _ := json.Marshal(v)
	fmt.Println(string(j))
}
