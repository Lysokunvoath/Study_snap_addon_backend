#!/usr/bin/env python3
# pyright: reportMissingImports=false
import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser(description='Transcribe wav audio with NeMo Parakeet .nemo model')
    parser.add_argument('--model', required=True, help='Path to .nemo model file')
    parser.add_argument('--wav', required=True, help='Path to wav file')
    parser.add_argument('--language', default='en-US', help='Language hint')
    parser.add_argument('--device', default='auto', choices=['auto', 'cpu', 'cuda'])
    args = parser.parse_args()

    if not os.path.exists(args.model):
        print(json.dumps({'error': f'Model not found: {args.model}'}))
        return 2

    if not os.path.exists(args.wav):
        print(json.dumps({'error': f'WAV not found: {args.wav}'}))
        return 2

    try:
        import torch
        from nemo.collections.asr.models import ASRModel
    except Exception as exc:
        print(json.dumps({'error': f'Missing NeMo dependencies: {exc}'}))
        return 3

    try:
        model = ASRModel.restore_from(restore_path=args.model)

        if args.device == 'cuda':
            model = model.cuda()
        elif args.device == 'cpu':
            model = model.cpu()
        else:
            model = model.cuda() if torch.cuda.is_available() else model.cpu()

        outputs = model.transcribe([args.wav], batch_size=1)

        text = ''
        if isinstance(outputs, list) and outputs:
            first = outputs[0]
            text = first if isinstance(first, str) else str(first)
        else:
            text = str(outputs)

        print(json.dumps({'text': text.strip(), 'language': args.language}))
        return 0
    except Exception as exc:
        print(json.dumps({'error': f'Inference failed: {exc}'}))
        return 4


if __name__ == '__main__':
    sys.exit(main())
